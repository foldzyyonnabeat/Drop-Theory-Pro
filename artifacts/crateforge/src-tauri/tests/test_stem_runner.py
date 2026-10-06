import importlib.util
import hashlib
import http.server
import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import threading
import types
import urllib.parse
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch


RUNNER_PATH = pathlib.Path(__file__).parents[1] / "src" / "stem_runner.py"
SPEC = importlib.util.spec_from_file_location("stem_runner", RUNNER_PATH)
stem_runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stem_runner)


class FakeTensor:
    def __init__(self, shape, finite=True):
        self.shape = shape
        self.finite = finite


class FakeFiniteResult:
    def __init__(self, finite):
        self.finite = finite

    def all(self):
        return self.finite


class FakeNumpy:
    float32 = "float32"

    @staticmethod
    def zeros(shape, dtype):
        if dtype != FakeNumpy.float32:
            raise AssertionError("smoke-test input must use float32")
        return FakeTensor(shape)

    @staticmethod
    def asarray(value):
        return value

    @staticmethod
    def isfinite(value):
        return FakeFiniteResult(value.finite)


class FakeSession:
    def __init__(self, outputs=None, error=None):
        self.outputs = outputs
        self.error = error
        self.calls = []

    def run(self, output_names, inputs):
        self.calls.append((output_names, inputs))
        if self.error:
            raise self.error
        return self.outputs


def manifest(chunk_samples=8):
    return {
        "channels": 2,
        "chunkSamples": chunk_samples,
        "inputName": "mix",
        "outputNames": {
            "vocals": "vocals_out",
            "drums": "drums_out",
            "bass": "bass_out",
            "other": "other_out",
        },
    }


def valid_outputs(chunk_samples=8):
    return [FakeTensor((1, 2, chunk_samples)) for _ in range(4)]


class InferenceSmokeTest(unittest.TestCase):
    def test_runs_one_bounded_float32_chunk_and_checks_four_outputs(self):
        session = FakeSession(valid_outputs())

        stem_runner.run_inference_smoke_test(FakeNumpy, manifest(), session)

        self.assertEqual(len(session.calls), 1)
        output_names, inputs = session.calls[0]
        self.assertEqual(
            output_names,
            ["vocals_out", "drums_out", "bass_out", "other_out"],
        )
        self.assertEqual(list(inputs), ["mix"])
        self.assertEqual(inputs["mix"].shape, (1, 2, 8))

    def test_reports_runtime_inference_failure(self):
        session = FakeSession(error=RuntimeError("graph execution failed"))

        with self.assertRaisesRegex(
            RuntimeError, "Inference smoke test failed.*graph execution failed"
        ):
            stem_runner.run_inference_smoke_test(FakeNumpy, manifest(), session)

    def test_rejects_a_missing_stem_output(self):
        session = FakeSession(valid_outputs()[:3])

        with self.assertRaisesRegex(
            ValueError, "malformed four-stem outputs.*expected 4"
        ):
            stem_runner.run_inference_smoke_test(FakeNumpy, manifest(), session)

    def test_rejects_an_output_with_the_wrong_shape(self):
        outputs = valid_outputs()
        outputs[1] = FakeTensor((1, 2, 7))
        session = FakeSession(outputs)

        with self.assertRaisesRegex(
            ValueError, "malformed drums output.*expected shape \\[1, 2, 8\\]"
        ):
            stem_runner.run_inference_smoke_test(FakeNumpy, manifest(), session)

    def test_rejects_non_finite_values(self):
        outputs = valid_outputs()
        outputs[2] = FakeTensor((1, 2, 8), finite=False)
        session = FakeSession(outputs)

        with self.assertRaisesRegex(
            ValueError, "invalid values in the bass output.*finite"
        ):
            stem_runner.run_inference_smoke_test(FakeNumpy, manifest(), session)


class ProgressCaptureTests(unittest.TestCase):
    def test_parses_model_download_and_chunk_progress_into_json_events(self):
        output = io.StringIO()
        with patch.object(stem_runner, "PROTOCOL_STDOUT", output):
            reporter = stem_runner.ProgressCapture("htdemucs_ft")
            reporter.write("Downloading model file 30%\n")
            for _ in range(4):
                reporter.write("    chunk 1/2: 0.1s elapsed\n")
                reporter.write("    chunk 2/2: 0.2s elapsed\n")
            reporter.flush()

        events = [json.loads(line) for line in output.getvalue().splitlines()]
        percentages = [event["percent"] for event in events]
        self.assertEqual(percentages, sorted(percentages))
        self.assertEqual(percentages[-1], 94)
        self.assertIn("Downloading model weights", events[0]["message"])
        self.assertIn("chunk 2 of 2", events[-1]["message"])

    def test_retry_progress_starts_at_the_existing_percentage_and_remains_monotonic(self):
        output = io.StringIO()
        with patch.object(stem_runner, "PROTOCOL_STDOUT", output):
            reporter = stem_runner.ProgressCapture("htdemucs", progress_floor=60)
            reporter.write("    chunk 1/2: 0.1s elapsed\n")
            reporter.write("    chunk 2/2: 0.2s elapsed\n")

        events = [json.loads(line) for line in output.getvalue().splitlines()]
        percentages = [event["percent"] for event in events]
        self.assertEqual(percentages, sorted(percentages))
        self.assertGreaterEqual(percentages[0], 60)
        self.assertEqual(percentages[-1], 94)


class DirectMLMemoryErrorTests(unittest.TestCase):
    def test_detects_wrapped_directml_out_of_memory_errors(self):
        provider_error = RuntimeError(
            "DmlFusedNode_0_0 failed with 8007000E: Not enough memory resources."
        )
        error = RuntimeError("ONNX Runtime execution failed")
        error.__cause__ = provider_error

        self.assertTrue(stem_runner.is_directml_memory_error(error))

    def test_does_not_retry_other_directml_errors_or_cpu_memory_errors(self):
        self.assertFalse(
            stem_runner.is_directml_memory_error(
                RuntimeError("DmlFusedNode failed because the input shape is invalid.")
            )
        )
        self.assertFalse(
            stem_runner.is_directml_memory_error(
                RuntimeError("CPU out of memory while writing stems.")
            )
        )


class ModelWeightDownloadTests(unittest.TestCase):
    def hub(self):
        hub = types.SimpleNamespace()
        hub.BAG_STEMS = ("drums", "bass", "other", "vocals")
        hub.MODEL_REPOS = {
            "htdemucs_ft_" + stem: "public/" + stem for stem in hub.BAG_STEMS
        }
        hub.MODEL_REGISTRY = {
            "htdemucs": types.SimpleNamespace(kind="single", repo="public/speed")
        }
        hub.stem_model_filename = lambda stem, precision: stem + "_" + precision + ".onnx"
        hub.model_filename = lambda model, precision: model + "_" + precision + ".onnx"
        return hub

    def test_all_model_profiles_download_the_correct_files_with_monotonic_progress(self):
        for model, precision, expected_count in (
            ("htdemucs_ft", "fp32", 4),
            ("htdemucs_ft", "fp16weights", 4),
            ("htdemucs", "fp32", 1),
        ):
            with self.subTest(model=model, precision=precision), tempfile.TemporaryDirectory() as folder:
                hub = self.hub()
                def fetch(repo, filename):
                    print("Downloading 30%\rDownloading 100%\r", end="")
                    path = pathlib.Path(folder, filename)
                    path.write_bytes(b"model fixture")
                    return path
                hub._hub_download = Mock(side_effect=fetch)
                output = io.StringIO()
                with (
                    patch.object(stem_runner, "bundled_model_paths", return_value=None),
                    patch.object(stem_runner, "cached_model_path", return_value=None),
                    patch.object(stem_runner.importlib, "import_module", return_value=hub),
                    patch.object(stem_runner, "PROTOCOL_STDOUT", output),
                ):
                    paths = stem_runner.prepare_model_weights(model, precision)
                self.assertEqual(len(paths), expected_count)
                self.assertEqual(hub._hub_download.call_count, expected_count)
                self.assertTrue(all(precision in filename for _, filename in paths))
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                percentages = [event["percent"] for event in events]
                self.assertEqual(percentages, sorted(percentages))
                self.assertEqual(percentages[-1], 100)

    def test_cached_weights_do_not_contact_hugging_face(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder, "model.onnx")
            path.write_bytes(b"cached model")
            hub = self.hub()
            hub._hub_download = Mock(side_effect=AssertionError("unexpected network access"))
            with (
                patch.object(stem_runner, "bundled_model_paths", return_value=None),
                patch.object(stem_runner, "cached_model_path", return_value=path),
                patch.object(stem_runner.importlib, "import_module", return_value=hub),
                patch.object(stem_runner, "PROTOCOL_STDOUT", io.StringIO()),
            ):
                paths = stem_runner.prepare_model_weights("htdemucs", "fp32")
            self.assertEqual(list(paths.values()), [path])
            hub._hub_download.assert_not_called()

    def test_interrupted_download_retries_without_losing_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder, "model.onnx")
            path.write_bytes(b"resumed model")
            hub = self.hub()
            attempts = 0
            def fetch(repo, filename):
                nonlocal attempts
                attempts += 1
                print("Downloading 50%\r", end="")
                if attempts == 1:
                    raise ConnectionError("connection interrupted")
                return path
            hub._hub_download = Mock(side_effect=fetch)
            output = io.StringIO()
            with (
                patch.object(stem_runner, "bundled_model_paths", return_value=None),
                patch.object(stem_runner, "cached_model_path", return_value=None),
                patch.object(stem_runner.importlib, "import_module", return_value=hub),
                patch.object(stem_runner, "PROTOCOL_STDOUT", output),
                patch.object(stem_runner.time, "sleep") as sleep,
            ):
                stem_runner.prepare_model_weights("htdemucs", "fp32")
            self.assertEqual(attempts, 2)
            sleep.assert_called_once_with(1)
            percentages = [json.loads(line)["percent"] for line in output.getvalue().splitlines()]
            self.assertEqual(percentages, sorted(percentages))

    def test_permanent_error_is_visible_without_retrying(self):
        hub = self.hub()
        hub._hub_download = Mock(side_effect=ValueError("model file not found"))
        with (
            patch.object(stem_runner, "bundled_model_paths", return_value=None),
            patch.object(stem_runner, "cached_model_path", return_value=None),
            patch.object(stem_runner.importlib, "import_module", return_value=hub),
            patch.object(stem_runner, "PROTOCOL_STDOUT", io.StringIO()),
            patch.object(stem_runner.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "model file not found.*Retry"):
                stem_runner.prepare_model_weights("htdemucs", "fp32")
        hub._hub_download.assert_called_once()
        sleep.assert_not_called()

    def test_empty_weight_file_is_not_reported_as_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder, "model.onnx")
            path.touch()
            hub = self.hub()
            hub._hub_download = Mock(return_value=path)
            with (
                patch.object(stem_runner, "bundled_model_paths", return_value=None),
                patch.object(stem_runner, "cached_model_path", return_value=None),
                patch.object(stem_runner.importlib, "import_module", return_value=hub),
                patch.object(stem_runner, "PROTOCOL_STDOUT", io.StringIO()),
            ):
                with self.assertRaisesRegex(RuntimeError, "missing or empty"):
                    stem_runner.prepare_model_weights("htdemucs", "fp32")

    def test_separation_uses_prepared_files_without_a_second_download(self):
        hub = self.hub()
        original_download = Mock(side_effect=AssertionError("unexpected second download"))
        hub._hub_download = original_download
        prepared = {("public/speed", "htdemucs_fp32.onnx"): pathlib.Path("cached.onnx")}
        demucs = types.SimpleNamespace()
        def separate(*args, **kwargs):
            self.assertEqual(
                hub._hub_download("public/speed", "htdemucs_fp32.onnx"),
                pathlib.Path("cached.onnx"),
            )
            return {
                stem: types.SimpleNamespace(ndim=2, shape=(2, 8), T="audio")
                for stem in ("vocals", "drums", "bass", "other")
            }
        demucs.separate = separate
        numpy = types.ModuleType("numpy")
        numpy.float32 = "float32"
        numpy.asarray = lambda value, dtype: value
        numpy.isfinite = lambda value: types.SimpleNamespace(all=lambda: True)
        numpy.clip = lambda value, lower, upper: value
        soundfile = types.ModuleType("soundfile")
        soundfile.info = lambda path: types.SimpleNamespace(samplerate=44100)
        soundfile.write = Mock()
        ort = types.SimpleNamespace(get_available_providers=lambda: ["CPUExecutionProvider"])
        with (
            tempfile.TemporaryDirectory() as output,
            patch.dict("sys.modules", {"numpy": numpy, "soundfile": soundfile}),
            patch.object(stem_runner, "load_local_runtime_modules", return_value=(demucs, ort)),
            patch.object(stem_runner, "bundled_model_paths", return_value=None),
            patch.object(stem_runner, "prepare_model_weights", return_value=prepared),
            patch.object(stem_runner.importlib, "import_module", return_value=hub),
            patch.object(stem_runner, "PROTOCOL_STDOUT", io.StringIO()),
        ):
            stem_runner.separate_pretrained("htdemucs", "fp32", "track.wav", output)
        original_download.assert_not_called()
        self.assertIs(hub._hub_download, original_download)
        self.assertEqual(soundfile.write.call_count, 4)

    def test_directml_out_of_memory_retries_with_cpu_and_preserves_prepared_weights(self):
        hub = self.hub()
        original_download = Mock(return_value=pathlib.Path("unexpected-network-download.onnx"))
        hub._hub_download = original_download
        prepared_path = pathlib.Path("cached.onnx")
        prepared = {("public/speed", "htdemucs_fp32.onnx"): prepared_path}
        pool = types.SimpleNamespace(clear=Mock())
        stems = {
            name: types.SimpleNamespace(ndim=2, shape=(2, 8), T="audio")
            for name in ("vocals", "drums", "bass", "other")
        }

        def separate(*args, **kwargs):
            self.assertEqual(
                hub._hub_download("public/speed", "htdemucs_fp32.onnx"),
                prepared_path,
            )
            if kwargs["providers"] == "auto":
                raise RuntimeError(
                    "DmlFusedNode_0_0 failed with 8007000E: "
                    "Not enough memory resources."
                )
            self.assertEqual(kwargs["providers"], "cpu")
            return stems

        demucs = types.SimpleNamespace(
            separate=Mock(side_effect=separate),
            session_pool=Mock(return_value=pool),
        )
        numpy = types.ModuleType("numpy")
        numpy.float32 = "float32"
        numpy.asarray = lambda value, dtype: value
        numpy.isfinite = lambda value: types.SimpleNamespace(all=lambda: True)
        numpy.clip = lambda value, lower, upper: value
        soundfile = types.ModuleType("soundfile")
        soundfile.info = lambda path: types.SimpleNamespace(samplerate=44100)
        soundfile.write = Mock()
        ort = types.SimpleNamespace(
            get_available_providers=lambda: [
                "DmlExecutionProvider",
                "CPUExecutionProvider",
            ]
        )
        output = io.StringIO()

        with (
            tempfile.TemporaryDirectory() as output_directory,
            patch.dict("sys.modules", {"numpy": numpy, "soundfile": soundfile}),
            patch.object(
                stem_runner,
                "load_local_runtime_modules",
                return_value=(demucs, ort),
            ),
            patch.object(stem_runner, "bundled_model_paths", return_value=None),
            patch.object(stem_runner, "prepare_model_weights", return_value=prepared),
            patch.object(stem_runner.importlib, "import_module", return_value=hub),
            patch.object(stem_runner, "PROTOCOL_STDOUT", output),
            patch.object(stem_runner.gc, "collect") as collect,
        ):
            stem_runner.separate_pretrained(
                "htdemucs", "fp32", "track.wav", output_directory
            )

        self.assertEqual(
            [call.kwargs["providers"] for call in demucs.separate.call_args_list],
            ["auto", "cpu"],
        )
        pool.clear.assert_called_once()
        collect.assert_called_once()
        self.assertIs(hub._hub_download, original_download)
        self.assertEqual(soundfile.write.call_count, 4)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertTrue(
            any(
                "retrying this separation on CPU" in event["message"]
                for event in events
            )
        )
        percentages = [event["percent"] for event in events]
        self.assertEqual(percentages, sorted(percentages))

    def test_cache_lookup_rejects_missing_and_empty_files(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder, "model.onnx")
            huggingface = types.ModuleType("huggingface_hub")
            huggingface.try_to_load_from_cache = Mock(return_value=str(path))
            with patch.dict("sys.modules", {"huggingface_hub": huggingface}):
                self.assertIsNone(stem_runner.cached_model_path("public/model", "model.onnx"))
                path.touch()
                self.assertIsNone(stem_runner.cached_model_path("public/model", "model.onnx"))
                path.write_bytes(b"valid cache fixture")
                self.assertEqual(stem_runner.cached_model_path("public/model", "model.onnx"), path)


class LocalHubFixture:
    """Small Hub-compatible HTTP fixture for the bundled huggingface_hub downloader."""

    COMMIT = "1234567890abcdef1234567890abcdef12345678"

    def __init__(self, files, *, interrupt_once=None, interrupt_always=False):
        self.files = files
        self.interrupt_once = interrupt_once
        self.interrupt_always = interrupt_always
        self.requests = []
        self.interrupted = threading.Event()
        self.release_interruption = threading.Event()
        self.range_requested = threading.Event()
        self.release_range = threading.Event()
        self.authorization_seen = threading.Event()
        self._lock = threading.Lock()
        self._interrupted_once = False
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def _file(self):
                path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
                parts = path.strip("/").split("/")
                if len(parts) != 5 or parts[2] != "resolve" or parts[3] != "main":
                    self.send_error(404)
                    return None, None
                return "/".join(parts[:2]), parts[4]

            def do_HEAD(self):
                if self.headers.get("Authorization"):
                    fixture.authorization_seen.set()
                repo, filename = self._file()
                if repo is None or (repo, filename) not in fixture.files:
                    self.send_error(404)
                    return
                content = fixture.files[(repo, filename)]
                self.send_response(200)
                self.send_header("ETag", '"' + hashlib.sha256(content).hexdigest() + '"')
                self.send_header("X-Repo-Commit", fixture.COMMIT)
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                with fixture._lock:
                    fixture.requests.append(("HEAD", repo, filename, None))

            def do_GET(self):
                if self.headers.get("Authorization"):
                    fixture.authorization_seen.set()
                repo, filename = self._file()
                if repo is None or (repo, filename) not in fixture.files:
                    self.send_error(404)
                    return
                content = fixture.files[(repo, filename)]
                range_header = self.headers.get("Range")
                range_start = 0
                if range_header:
                    try:
                        range_start = int(range_header.removeprefix("bytes=").split("-", 1)[0])
                    except ValueError:
                        self.send_error(400)
                        return
                    if range_start >= len(content):
                        self.send_error(416)
                        return
                    status = 206
                else:
                    status = 200

                with fixture._lock:
                    fixture.requests.append(("GET", repo, filename, range_header))
                    should_interrupt = fixture.interrupt_always or (
                        fixture.interrupt_once == (repo, filename)
                        and not fixture._interrupted_once
                    )
                    if should_interrupt and not fixture.interrupt_always:
                        fixture._interrupted_once = True

                self.send_response(status)
                self.send_header("ETag", '"' + hashlib.sha256(content).hexdigest() + '"')
                self.send_header("X-Repo-Commit", fixture.COMMIT)
                if range_header:
                    self.send_header(
                        "Content-Range",
                        f"bytes {range_start}-{len(content) - 1}/{len(content)}",
                    )
                self.send_header("Content-Length", str(len(content) - range_start))
                self.send_header("Connection", "close")
                self.end_headers()

                if should_interrupt:
                    if not fixture.interrupt_always:
                        # Exceed Python's buffered-write size so the Hub downloader's
                        # partial bytes are visible to stat() while the file is open.
                        self.wfile.write(content[range_start:range_start + 32 * 1024])
                        self.wfile.flush()
                        fixture.interrupted.set()
                        fixture.release_interruption.wait(30)
                    self.close_connection = True
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    self.connection.close()
                    return

                if range_header:
                    fixture.range_requested.set()
                    if not fixture.interrupt_always:
                        fixture.release_range.wait(30)
                self.wfile.write(content[range_start:])
                self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.release_interruption.set()
        self.release_range.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def get_requests(self):
        with self._lock:
            return list(self.requests)


class BundledHubDownloadIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.runtime_site_packages = (
            pathlib.Path(__file__).parents[1]
            / "resources"
            / "stem-runtime"
            / "Lib"
            / "site-packages"
        )
        self._missing = object()
        self.previous_demucs_package = sys.modules.get("demucs_onnx", self._missing)
        self.previous_hub_module = sys.modules.get("demucs_onnx._hub", self._missing)
        sys.path.insert(0, str(self.runtime_site_packages))
        try:
            self.huggingface_hub = __import__("huggingface_hub")
            self.hub_constants = __import__(
                "huggingface_hub.constants", fromlist=["constants"]
            )
            self.file_download = __import__(
                "huggingface_hub.file_download", fromlist=["file_download"]
            )
            # The bundled demucs package imports its Windows NumPy binaries at
            # package import time. Load its pure-Python registry module under a
            # lightweight package shell so this transport test also runs on Linux.
            package = types.ModuleType("demucs_onnx")
            package.__path__ = [
                str(self.runtime_site_packages / "demucs_onnx")
            ]
            sys.modules["demucs_onnx"] = package
            self.hub = __import__("importlib").import_module("demucs_onnx._hub")
            self.demucs = types.SimpleNamespace(separate=None)
        except Exception:
            sys.path.remove(str(self.runtime_site_packages))
            raise
        sys.path.remove(str(self.runtime_site_packages))

    def tearDown(self):
        for name, previous in (
            ("demucs_onnx._hub", self.previous_hub_module),
            ("demucs_onnx", self.previous_demucs_package),
        ):
            if previous is self._missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous

    def _local_hub_settings(self, fixture, cache_dir):
        return (
            patch.object(
                self.file_download,
                "HUGGINGFACE_CO_URL_TEMPLATE",
                fixture.url + "/{repo_id}/resolve/{revision}/{filename}",
            ),
            patch.object(self.hub_constants, "HF_HUB_CACHE", str(cache_dir)),
            patch.object(self.file_download.constants, "DOWNLOAD_CHUNK_SIZE", 4096),
            patch.object(self.file_download.constants, "HF_HUB_DOWNLOAD_TIMEOUT", 30),
            patch.object(self.hub_constants, "HF_HUB_DISABLE_IMPLICIT_TOKEN", True),
        )

    def test_pinned_downloader_resumes_ft_files_and_separation_uses_cache(self):
        self.assertEqual(self.huggingface_hub.__version__, "0.36.0")
        entries = stem_runner._model_repository_files(self.hub, "htdemucs_ft", "fp32")
        fixture_files = {
            (repo, filename): (filename.encode("utf-8") + b"-fixture-") * 4096
            for repo, filename in entries
        }
        interrupted_entry = entries[0]
        fixture = LocalHubFixture(
            fixture_files,
            interrupt_once=interrupted_entry,
        )

        with tempfile.TemporaryDirectory() as cache_folder, fixture:
            settings = self._local_hub_settings(fixture, cache_folder)
            with settings[0], settings[1], settings[2], settings[3], settings[4]:
                with (
                    patch.object(stem_runner.time, "sleep"),
                    patch.object(stem_runner, "PROTOCOL_STDOUT", io.StringIO()),
                ):
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        preparation = executor.submit(
                            stem_runner.prepare_model_weights, "htdemucs_ft", "fp32"
                        )
                        try:
                            self.assertTrue(fixture.interrupted.wait(5), "fixture did not interrupt a transfer")
                            partial_path = None
                            for _ in range(500):
                                candidates = list(
                                    pathlib.Path(cache_folder).rglob("*.incomplete")
                                )
                                partial_path = next(
                                    (
                                        candidate
                                        for candidate in candidates
                                        if candidate.stat().st_size > 0
                                    ),
                                    None,
                                )
                                if partial_path is not None:
                                    break
                                threading.Event().wait(0.01)
                            self.assertIsNotNone(
                                partial_path,
                                "the interrupted response did not leave resumable partial bytes; "
                                + "cache files: "
                                + repr(
                                    [
                                        str(candidate.relative_to(cache_folder))
                                        for candidate in pathlib.Path(cache_folder).rglob("*")
                                    ]
                                )
                                + "; requests: "
                                + repr(fixture.get_requests()),
                            )
                            self.assertGreater(partial_path.stat().st_size, 0)
                            self.assertIsNone(
                                stem_runner.cached_model_path(*interrupted_entry),
                                "an incomplete transfer was published as a ready cache file",
                            )
                            self.assertFalse(
                                stem_runner.model_weights_cached("htdemucs_ft", "fp32"),
                                "the FT profile was ready while a required file was partial",
                            )
                            fixture.release_interruption.set()
                            self.assertTrue(
                                fixture.range_requested.wait(5),
                                "the downloader did not request the missing byte range",
                            )
                            partial_size_at_resume = partial_path.stat().st_size
                            self.assertIsNone(
                                stem_runner.cached_model_path(*interrupted_entry),
                                "a partial file became cache-ready before its range completed",
                            )
                            range_headers = [
                                request[3]
                                for request in fixture.get_requests()
                                if request[0] == "GET"
                                and request[1:3] == interrupted_entry
                                and request[3] is not None
                            ]
                            self.assertIn(
                                f"bytes={partial_size_at_resume}-",
                                range_headers,
                            )
                            fixture.release_range.set()
                            prepared_paths = preparation.result(timeout=10)
                            self.assertFalse(partial_path.exists())
                        finally:
                            fixture.release_interruption.set()
                            fixture.release_range.set()

                self.assertEqual(len(prepared_paths), 4)
                self.assertEqual(
                    pathlib.Path(prepared_paths[interrupted_entry]).read_bytes(),
                    fixture_files[interrupted_entry],
                )
                requests_after_download = fixture.get_requests()
                resumed_gets = [
                    request for request in requests_after_download
                    if request[0] == "GET"
                    and request[1:3] == interrupted_entry
                    and request[3] is not None
                ]
                self.assertTrue(resumed_gets, "the interrupted file was not resumed with Range")
                self.assertTrue(stem_runner.model_weights_cached("htdemucs_ft", "fp32"))

                # All four completed FT files are now local. Neither another
                # preparation nor separation of a local track should touch HTTP.
                again = stem_runner.prepare_model_weights("htdemucs_ft", "fp32")
                self.assertEqual(again, prepared_paths)

                class FakeAudio:
                    ndim = 2
                    shape = (2, 8)
                    T = "transposed audio"

                fake_numpy = types.ModuleType("numpy")
                fake_numpy.float32 = "float32"
                fake_numpy.asarray = lambda value, dtype: value
                fake_numpy.isfinite = lambda _value: FakeFiniteResult(True)
                fake_numpy.clip = lambda value, _lower, _upper: value
                fake_soundfile = types.ModuleType("soundfile")
                fake_soundfile.info = lambda _path: types.SimpleNamespace(samplerate=44100)
                fake_soundfile.write = Mock()
                ort = types.SimpleNamespace(
                    get_available_providers=lambda: ["CPUExecutionProvider"]
                )

                def separate_local(*_args, **_kwargs):
                    for repo, filename in entries:
                        self.assertEqual(
                            pathlib.Path(self.hub._hub_download(repo, filename)).read_bytes(),
                            fixture_files[(repo, filename)],
                        )
                    return {
                        name: FakeAudio()
                        for name in ("vocals", "drums", "bass", "other")
                    }

                with (
                    patch.dict(
                        "sys.modules",
                        {"numpy": fake_numpy, "soundfile": fake_soundfile},
                    ),
                    patch.object(stem_runner, "load_local_runtime_modules", return_value=(self.demucs, ort)),
                    patch.object(self.demucs, "separate", side_effect=separate_local),
                    patch.object(stem_runner, "PROTOCOL_STDOUT", io.StringIO()),
                ):
                    with patch.object(stem_runner.time, "sleep"):
                        stem_runner.separate_pretrained(
                            "htdemucs_ft", "fp32", "local-track.wav", cache_folder
                        )

                self.assertEqual(fixture.get_requests(), requests_after_download)
                self.assertEqual(fake_soundfile.write.call_count, 4)
                self.assertFalse(fixture.authorization_seen.is_set())

    def test_exhausted_connection_retries_leave_an_actionable_error(self):
        self.assertEqual(self.huggingface_hub.__version__, "0.36.0")
        entries = stem_runner._model_repository_files(self.hub, "htdemucs", "fp32")
        fixture = LocalHubFixture(
            {entries[0]: b"small model fixture" * 2048},
            interrupt_always=True,
        )
        with tempfile.TemporaryDirectory() as cache_folder, fixture:
            settings = self._local_hub_settings(fixture, cache_folder)
            output = io.StringIO()
            with (
                settings[0],
                settings[1],
                settings[2],
                settings[3],
                settings[4],
                patch.object(stem_runner, "bundled_model_paths", return_value=None),
                patch.object(stem_runner, "PROTOCOL_STDOUT", output),
                patch.object(stem_runner.time, "sleep"),
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "Could not prepare .*Retry the model download; completed files remain in the local cache",
                ):
                    stem_runner.prepare_model_weights("htdemucs", "fp32")

            downloads = [
                request for request in fixture.get_requests() if request[0] == "GET"
            ]
            self.assertEqual(len(downloads), 3, "the bounded outer retries were not exhausted")
            self.assertFalse(stem_runner.model_weights_cached("htdemucs", "fp32"))
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertTrue(
                any("retrying" in event["message"].lower() for event in events),
                "the failed download did not report its retry state",
            )
            self.assertFalse(fixture.authorization_seen.is_set())


class PretrainedRuntimeTests(unittest.TestCase):
    def test_inspection_accepts_only_app_local_runtime_and_reports_cpu_support(self):
        with tempfile.TemporaryDirectory() as runtime:
            demucs = types.ModuleType("demucs_onnx")
            demucs.__file__ = str(pathlib.Path(runtime) / "demucs_onnx" / "__init__.py")
            demucs.__version__ = "test"
            demucs.list_models = lambda: {"htdemucs_ft": {}, "htdemucs": {}}

            onnxruntime = types.ModuleType("onnxruntime")
            onnxruntime.__file__ = str(pathlib.Path(runtime) / "onnxruntime" / "__init__.py")
            onnxruntime.__version__ = "test"
            onnxruntime.get_available_providers = lambda: ["CPUExecutionProvider"]

            output = io.StringIO()
            with (
                patch.dict(os.environ, {"CRATEFORGE_STEM_RUNTIME": runtime}),
                patch.dict(
                    "sys.modules",
                    {"demucs_onnx": demucs, "onnxruntime": onnxruntime},
                ),
                patch.object(stem_runner, "PROTOCOL_STDOUT", output),
                patch.object(stem_runner, "model_weights_cached", return_value=False),
            ):
                stem_runner.inspect_pretrained("htdemucs_ft", "fp32")

            response = json.loads(output.getvalue())
            self.assertTrue(response["compatible"])
            self.assertEqual(response["runtimeVersion"], "test")
            self.assertEqual(response["modelId"], "htdemucs_ft")
            self.assertFalse(response["modelsBundled"])
            self.assertFalse(response["modelsCached"])

    def test_offline_bundle_resolves_every_model_profile_without_hub_downloads(self):
        stems = ("drums", "bass", "other", "vocals")
        repos = {
            "drums": "StemSplitio/htdemucs-ft-drums-onnx",
            "bass": "StemSplitio/htdemucs-ft-bass-onnx",
            "other": "StemSplitio/htdemucs-ft-other-onnx",
            "vocals": "StemSplitio/htdemucs-ft-vocals-onnx",
        }
        hub = types.ModuleType("demucs_onnx._hub")
        hub.BAG_STEMS = stems
        hub.MODEL_REPOS = {"htdemucs_ft_" + stem: repo for stem, repo in repos.items()}
        hub.MODEL_REGISTRY = {
            "htdemucs": types.SimpleNamespace(
                kind="single",
                repo="StemSplitio/htdemucs-onnx",
            )
        }
        hub.stem_model_filename = lambda stem, precision: (
            f"htdemucs_ft_{stem}"
            + ("_fp16weights" if precision == "fp16weights" else "")
            + ".onnx"
        )
        hub.model_filename = lambda model, precision: "htdemucs.onnx"

        def unexpected_download(*args, **kwargs):
            raise AssertionError("the offline model resolver must not use Hugging Face")

        hub._hub_download = unexpected_download

        with tempfile.TemporaryDirectory() as runtime, tempfile.TemporaryDirectory() as model_root:
            demucs = types.ModuleType("demucs_onnx")
            demucs.__file__ = str(pathlib.Path(runtime) / "demucs_onnx" / "__init__.py")
            demucs.__version__ = "test"
            demucs.list_models = lambda: {"htdemucs_ft": {}, "htdemucs": {}}

            onnxruntime = types.ModuleType("onnxruntime")
            onnxruntime.__file__ = str(pathlib.Path(runtime) / "onnxruntime" / "__init__.py")
            onnxruntime.__version__ = "test"
            onnxruntime.get_available_providers = lambda: ["CPUExecutionProvider"]

            for stem, repo in repos.items():
                for precision in ("fp32", "fp16weights"):
                    filename = hub.stem_model_filename(stem, precision)
                    destination = pathlib.Path(model_root, *repo.split("/"), filename)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(b"offline fixture")
            speed_path = pathlib.Path(
                model_root,
                "StemSplitio",
                "htdemucs-onnx",
                "htdemucs.onnx",
            )
            speed_path.parent.mkdir(parents=True, exist_ok=True)
            speed_path.write_bytes(b"offline fixture")

            with (
                patch.dict(
                    os.environ,
                    {
                        "CRATEFORGE_STEM_RUNTIME": runtime,
                        "CRATEFORGE_STEM_MODELS": model_root,
                    },
                ),
                patch.dict(
                    "sys.modules",
                    {
                        "demucs_onnx": demucs,
                        "demucs_onnx._hub": hub,
                        "onnxruntime": onnxruntime,
                    },
                ),
            ):
                full_paths = stem_runner.bundled_model_paths("htdemucs_ft", "fp32", demucs)
                compact_paths = stem_runner.bundled_model_paths(
                    "htdemucs_ft", "fp16weights", demucs
                )
                speed_paths = stem_runner.bundled_model_paths("htdemucs", "fp32", demucs)
                self.assertEqual(len(full_paths), 4)
                self.assertEqual(len(compact_paths), 4)
                self.assertEqual(len(speed_paths), 1)

                stem_runner.configure_bundled_model_downloads()
                vocals_repo = repos["vocals"]
                vocals_filename = hub.stem_model_filename("vocals", "fp16weights")
                self.assertEqual(
                    hub._hub_download(vocals_repo, vocals_filename),
                    compact_paths[(vocals_repo, vocals_filename)],
                )

                output = io.StringIO()
                with patch.object(stem_runner, "PROTOCOL_STDOUT", output):
                    stem_runner.inspect_pretrained("htdemucs_ft", "fp16weights")
                response = json.loads(output.getvalue())
                self.assertTrue(response["compatible"])
                self.assertTrue(response["modelsBundled"])
                self.assertIn("offline", response["message"])

                missing_repo = repos["drums"]
                missing_file = pathlib.Path(
                    model_root,
                    *missing_repo.split("/"),
                    hub.stem_model_filename("drums", "fp16weights"),
                )
                missing_file.unlink()
                with self.assertRaisesRegex(RuntimeError, "bundled model file is missing"):
                    stem_runner.bundled_model_paths("htdemucs_ft", "fp16weights", demucs)


if __name__ == "__main__":
    unittest.main()
