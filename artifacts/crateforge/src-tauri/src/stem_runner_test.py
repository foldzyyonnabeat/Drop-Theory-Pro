"""Dependency-light compatibility checks for the embedded stem runner.

The ONNX Runtime module is replaced with a fake session.  NumPy is the only
runtime dependency of the runner itself; these tests intentionally do not
create or download a real model.
"""

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


RUNNER_PATH = Path(__file__).with_name("stem_runner.py")
SPEC = importlib.util.spec_from_file_location("crateforge_stem_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class TensorInfo:
    def __init__(self, name, shape, tensor_type="tensor(float)"):
        self.name = name
        self.shape = shape
        self.type = tensor_type


class FakeSession:
    def __init__(self, behavior):
        self.behavior = behavior

    def get_inputs(self):
        return [TensorInfo("mix", [1, 2, 16])]

    def get_outputs(self):
        return [TensorInfo(name, [1, 2, 16]) for name in ("v", "d", "b", "o")]

    def run(self, names, feeds):
        return self.behavior(feeds)


class RuntimeDllDirectoryTests(unittest.TestCase):
    def test_uses_packaged_directory_manifest_without_walking_the_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime_root = root / "stem-runtime"
            site_packages = runtime_root / "Lib" / "site-packages"
            numpy_dlls = site_packages / "numpy.libs"
            onnx_dlls = site_packages / "onnxruntime" / "capi"
            numpy_dlls.mkdir(parents=True)
            onnx_dlls.mkdir(parents=True)
            (numpy_dlls / "numpy.dll").write_bytes(b"dll")
            (onnx_dlls / "onnxruntime.dll").write_bytes(b"dll")
            (runtime_root / "dll-search-directories.json").write_text(
                json.dumps(["numpy.libs", "onnxruntime/capi"]),
                encoding="utf-8",
            )

            with patch.object(runner.os, "walk", side_effect=AssertionError("runtime scan repeated")):
                directories = runner.runtime_dll_directories(str(site_packages))

            self.assertEqual(len(directories), 2)
            self.assertTrue(os.path.samefile(directories[0], numpy_dlls))
            self.assertTrue(os.path.samefile(directories[1], onnx_dlls))

    def test_uses_known_pinned_dll_directories_for_older_installs(self):
        with tempfile.TemporaryDirectory() as temporary:
            site_packages = Path(temporary) / "Lib" / "site-packages"
            onnx_dlls = site_packages / "onnxruntime" / "capi"
            onnx_dlls.mkdir(parents=True)
            (onnx_dlls / "onnxruntime.dll").write_bytes(b"dll")

            with patch.object(runner.os, "walk", side_effect=AssertionError("runtime scan repeated")):
                directories = runner.runtime_dll_directories(str(site_packages))

            self.assertEqual(len(directories), 1)
            self.assertTrue(os.path.samefile(directories[0], onnx_dlls))


def fake_modules(behavior):
    class FakeArray:
        def __init__(self, shape, dtype="float32", finite=True):
            self.shape = tuple(shape)
            self.dtype = dtype
            self.finite = finite
            self.nonzero = False

        def fill(self, value):
            self.nonzero = value != 0

    class FakeNumpy(types.ModuleType):
        float32 = "float32"

        @staticmethod
        def zeros(shape, dtype=None):
            return FakeArray(shape, dtype or "float32")

        @staticmethod
        def asarray(value):
            return value

        @staticmethod
        def dtype(value):
            return value

        @staticmethod
        def isfinite(value):
            return types.SimpleNamespace(all=lambda: value.finite)

    numpy = FakeNumpy("numpy")
    ort = types.ModuleType("onnxruntime")
    ort.__version__ = "test"
    ort.get_available_providers = lambda: ["CPUExecutionProvider"]
    ort.SessionOptions = type("SessionOptions", (), {})
    ort.InferenceSession = lambda *args, **kwargs: FakeSession(behavior)
    soundfile = types.ModuleType("soundfile")
    return {"onnxruntime": ort, "soundfile": soundfile, "numpy": numpy}


class RunnerInferenceTests(unittest.TestCase):
    def manifest_folder(self):
        folder = tempfile.TemporaryDirectory()
        root = Path(folder.name)
        (root / "model.onnx").write_bytes(b"fake")
        (root / "LICENSE-MODEL.txt").write_text("MIT")
        (root / "LICENSE-WEIGHTS.txt").write_text("MIT")
        (root / "crateforge-stem-model.json").write_text(
            json.dumps(
                {
                    "modelFile": "model.onnx",
                    "modelId": "test",
                    "inputName": "mix",
                    "channels": 2,
                    "chunkSamples": 16,
                    "sampleRate": 44100,
                    "outputNames": {
                        "vocals": "v",
                        "drums": "d",
                        "bass": "b",
                        "other": "o",
                    },
                }
            )
        )
        return folder, root

    def check(self, behavior):
        folder, root = self.manifest_folder()
        try:
            with patch.dict(sys.modules, fake_modules(behavior)):
                return runner.load_runtime(str(root / "crateforge-stem-model.json"))
        finally:
            folder.cleanup()

    def test_metadata_compatible_model_that_fails_run_is_rejected(self):
        numpy = fake_modules(lambda _: [])["numpy"]
        silent_outputs = [numpy.zeros((1, 2, 16))] * 4

        def fails(feeds):
            if feeds["mix"].nonzero:
                raise RuntimeError("non-silent inference kernel rejected input")
            return silent_outputs

        with self.assertRaisesRegex(ValueError, "non-silent inference kernel rejected input"):
            self.check(fails)

    def test_malformed_output_shape_is_rejected(self):
        def malformed(_feeds):
            return [fake_modules(lambda _: [])[ "numpy"].zeros((1, 2, 8))] * 4

        with self.assertRaisesRegex(ValueError, "invalid vocals output shape"):
            self.check(malformed)

    def test_nonfinite_output_is_rejected(self):
        def nonfinite(_feeds):
            numpy = fake_modules(lambda _: [])["numpy"]
            output = numpy.zeros((1, 2, 16))
            output.finite = False
            return [output] * 4

        with self.assertRaisesRegex(ValueError, "non-finite vocals"):
            self.check(nonfinite)


class UvrProviderFallbackTests(unittest.TestCase):
    def test_directml_failure_retries_the_non_silent_probe_on_cpu(self):
        attempted = []

        def operation(provider):
            attempted.append(provider)
            if provider == "DmlExecutionProvider":
                raise RuntimeError("DirectML could not execute this operator")
            return "checked"

        result, provider, fallback = runner._run_uvr_with_provider_fallback(
            "DmlExecutionProvider", operation
        )

        self.assertEqual(attempted, ["DmlExecutionProvider", "CPUExecutionProvider"])
        self.assertEqual(result, "checked")
        self.assertEqual(provider, "CPUExecutionProvider")
        self.assertEqual(fallback[0], "DirectML could not complete inference")

    def test_directml_memory_failure_is_reported_if_cpu_retry_fails(self):
        def operation(provider):
            if provider == "DmlExecutionProvider":
                raise RuntimeError("DirectML out of memory")
            raise RuntimeError("CPU inference kernel failed")

        with self.assertRaisesRegex(
            RuntimeError, "DirectML ran out of memory.*CPU retry failed: CPU inference kernel failed"
        ):
            runner._run_uvr_with_provider_fallback(
                "DmlExecutionProvider", operation
            )

    def test_cpu_failure_is_not_retried_as_a_second_provider(self):
        attempted = []

        def operation(provider):
            attempted.append(provider)
            raise RuntimeError("CPU inference kernel failed")

        with self.assertRaisesRegex(RuntimeError, "CPU inference kernel failed"):
            runner._run_uvr_with_provider_fallback("CPUExecutionProvider", operation)
        self.assertEqual(attempted, ["CPUExecutionProvider"])


if __name__ == "__main__":
    unittest.main()