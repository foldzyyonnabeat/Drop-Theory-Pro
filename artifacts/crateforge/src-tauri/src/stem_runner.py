import gc
import importlib
import json
import os
import re
import sys
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


PROTOCOL_STDOUT = sys.stdout
DLL_DIRECTORY_HANDLES = []
DLL_DIRECTORY_FALLBACKS = ("numpy.libs", "onnxruntime/capi", "_soundfile_data")
UVR_MODEL_CHOICE = "uvr-mdx-inst-hq-5"
UVR_MODEL_FILENAME = "UVR-MDX-NET-Inst_HQ_5.onnx"
UVR_MODEL_URL = (
    "https://github.com/TRvlvr/model_repo/releases/download/"
    "all_public_uvr_models/UVR-MDX-NET-Inst_HQ_5.onnx"
)
UVR_MODEL_SIZE = 59_074_342
UVR_MODEL_SHA256 = "811cb24095d865763752310848b7ec86aeede0626cb05749ab35350e46897000"
UVR_SAMPLE_RATE = 44_100
# UVR does not publish an HQ5-specific MDX metadata record. Its official
# custom-ONNX dialog defaults to 6144; use that documented fallback rather than
# borrowing FFT/compensation values from a different model.
UVR_N_FFT = 6_144
UVR_HOP_LENGTH = 1_024
UVR_FREQ_BINS = 2_560
UVR_SEGMENT_FRAMES = 256
UVR_OVERLAPS = (0.25, 0.50, 0.75, 0.99)


def configure_local_runtime():
    runtime = os.environ.get("CRATEFORGE_STEM_RUNTIME")
    if not runtime or not os.path.isdir(runtime):
        return
    runtime = os.path.realpath(runtime)
    if runtime not in sys.path:
        sys.path.insert(0, runtime)
    if os.name == "nt" and hasattr(os, "add_dll_directory"):
        for directory in runtime_dll_directories(runtime):
            try:
                DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(directory))
            except OSError:
                pass


def emit_progress(percent, message):
    print(
        json.dumps({"percent": int(percent), "message": message}),
        file=PROTOCOL_STDOUT,
        flush=True,
    )


def _path_is_within(path, root):
    try:
        return os.path.commonpath(
            [os.path.realpath(path), os.path.realpath(root)]
        ) == os.path.realpath(root)
    except (TypeError, ValueError):
        return False


def runtime_dll_directories(runtime):
    runtime = os.path.realpath(runtime)
    manifest = Path(runtime).parent.parent / "dll-search-directories.json"
    try:
        relative_directories = json.loads(manifest.read_text(encoding="utf-8"))
        if isinstance(relative_directories, list):
            directories = []
            for relative in relative_directories:
                if not isinstance(relative, str) or not relative:
                    continue
                directory = os.path.realpath(os.path.join(runtime, relative))
                if _path_is_within(directory, runtime) and os.path.isdir(directory):
                    directories.append(directory)
            if directories:
                return list(dict.fromkeys(directories))
    except (OSError, TypeError, ValueError):
        pass

    # Keep older installs fast; these are the DLL folders in the pinned runtime.
    known_directories = [
        os.path.join(runtime, *relative.split("/"))
        for relative in DLL_DIRECTORY_FALLBACKS
    ]
    known_directories = [path for path in known_directories if os.path.isdir(path)]
    if known_directories:
        return known_directories

    # Compatibility fallback for older or locally customized runtimes.
    directories = []
    for root, _, files in os.walk(runtime):
        if any(name.lower().endswith(".dll") for name in files):
            directories.append(root)
    return directories


def _model_repository_files(hub, model_name, precision):
    if precision not in ("fp32", "fp16weights"):
        raise ValueError("Unsupported built-in model precision.")
    if model_name == "htdemucs_ft":
        return [
            (
                hub.MODEL_REPOS["htdemucs_ft_" + stem],
                hub.stem_model_filename(stem, precision),
            )
            for stem in hub.BAG_STEMS
        ]
    info = hub.MODEL_REGISTRY.get(model_name)
    if info is None or info.kind != "single":
        raise ValueError("Unsupported built-in model profile.")
    return [(info.repo, hub.model_filename(model_name, precision))]


def bundled_model_paths(model_name, precision, demucs_onnx=None):
    model_root = os.environ.get("CRATEFORGE_STEM_MODELS")
    if not model_root:
        return None
    model_root = os.path.realpath(model_root)
    if not os.path.isdir(model_root):
        raise RuntimeError(
            "The bundled stem models are missing. Repair or reinstall Drop Theory Pro."
        )
    hub = importlib.import_module("demucs_onnx._hub")
    entries = _model_repository_files(hub, model_name, precision)
    paths = {}
    for repo_id, filename in entries:
        path = os.path.realpath(
            os.path.join(model_root, repo_id.replace("/", os.sep), filename)
        )
        if not _path_is_within(path, model_root) or not os.path.isfile(path):
            raise RuntimeError(
                "The bundled model file is missing: "
                + repo_id
                + "/"
                + filename
                + ". Repair or reinstall Drop Theory Pro."
            )
        paths[(repo_id, filename)] = Path(path)
    return paths


def configure_bundled_model_downloads():
    model_root = os.environ.get("CRATEFORGE_STEM_MODELS")
    if not model_root:
        return
    model_root = os.path.realpath(model_root)
    if not os.path.isdir(model_root):
        raise RuntimeError(
            "The bundled stem models are missing. Repair or reinstall Drop Theory Pro."
        )
    hub = importlib.import_module("demucs_onnx._hub")
    current_download = hub._hub_download
    if getattr(current_download, "__crateforge_bundled_root__", None) == model_root:
        return

    def download_bundled_model(repo_id, filename, *, cache_dir=None, token=None):
        path = os.path.realpath(
            os.path.join(model_root, repo_id.replace("/", os.sep), filename)
        )
        if not _path_is_within(path, model_root) or not os.path.isfile(path):
            raise RuntimeError(
                "The bundled model file is missing: "
                + repo_id
                + "/"
                + filename
                + ". Repair or reinstall Drop Theory Pro."
            )
        return Path(path)

    download_bundled_model.__crateforge_bundled_root__ = model_root
    hub._hub_download = download_bundled_model


def load_local_runtime_modules():
    runtime = os.environ.get("CRATEFORGE_STEM_RUNTIME")
    if not runtime or not os.path.isdir(runtime):
        raise RuntimeError("The bundled stem runtime is missing. Repair or reinstall Drop Theory Pro.")
    try:
        import demucs_onnx
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError(
            "The bundled stem packages could not be loaded. Repair or reinstall Drop Theory Pro."
        ) from error
    if not _path_is_within(getattr(demucs_onnx, "__file__", None), runtime):
        raise RuntimeError(
            "The bundled demucs-onnx package is missing. Repair or reinstall Drop Theory Pro."
        )
    if not _path_is_within(getattr(ort, "__file__", None), runtime):
        raise RuntimeError(
            "The bundled ONNX Runtime package is missing. Repair or reinstall Drop Theory Pro."
        )
    configure_bundled_model_downloads()
    return demucs_onnx, ort


def load_manifest(path):
    with open(path, "r", encoding="utf-8") as manifest_file:
        return json.load(manifest_file)


def load_runtime(manifest_path):
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf

    manifest = load_manifest(manifest_path)
    model_path = os.path.realpath(
        os.path.join(os.path.dirname(manifest_path), manifest["modelFile"])
    )
    root = os.path.realpath(os.path.dirname(manifest_path))
    if os.path.commonpath([model_path, root]) != root or not os.path.isfile(model_path):
        raise ValueError("The ONNX model must be a file inside the selected model folder.")

    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("This ONNX Runtime installation does not provide CPU inference.")
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        model_path, sess_options=options, providers=["CPUExecutionProvider"]
    )

    input_info = next(
        (item for item in session.get_inputs() if item.name == manifest["inputName"]),
        None,
    )
    if input_info is None or input_info.type != "tensor(float)":
        raise ValueError("The model input must be a float32 tensor with the declared name.")
    validate_shape(
        input_info.shape, manifest["chunkSamples"], manifest["channels"], "input"
    )
    output_names = manifest["outputNames"]
    for stem_name in ("vocals", "drums", "bass", "other"):
        tensor_name = output_names[stem_name]
        output_info = next(
            (item for item in session.get_outputs() if item.name == tensor_name), None
        )
        if output_info is None or output_info.type != "tensor(float)":
            raise ValueError(
                "The model is missing the declared float32 output for " + stem_name + "."
            )
        validate_shape(
            output_info.shape,
            manifest["chunkSamples"],
            manifest["channels"],
            stem_name + " output",
        )
    # Metadata describes the graph, but some providers only reject an invalid
    # graph when the first inference is submitted. Exercise the graph with a
    # low-amplitude, non-silent CPU input while the user is checking
    # compatibility so separation cannot fail unexpectedly at its first chunk.
    dummy_input = np.zeros(
        (1, manifest["channels"], manifest["chunkSamples"]), dtype=np.float32
    )
    dummy_input.fill(0.01)
    try:
        outputs = session.run(
            [output_names[name] for name in ("vocals", "drums", "bass", "other")],
            {manifest["inputName"]: dummy_input},
        )
    except Exception as error:
        raise ValueError(
            "The model failed its local CPU inference check: " + str(error)
        ) from error
    validate_inference_outputs(
        np, outputs, manifest["chunkSamples"], manifest["channels"]
    )
    return np, ort, sf, manifest, session


def validate_shape(shape, chunk_samples, channels, label):
    if len(shape) != 3:
        raise ValueError(label + " must have shape [1, 2, samples].")
    if isinstance(shape[0], int) and shape[0] != 1:
        raise ValueError(label + " batch dimension must be 1.")
    if isinstance(shape[1], int) and shape[1] != channels:
        raise ValueError(label + " channel dimension must be 2.")
    if isinstance(shape[2], int) and shape[2] != chunk_samples:
        raise ValueError(label + " sample dimension must match chunkSamples.")


def validate_inference_outputs(np, outputs, chunk_samples, channels):
    if len(outputs) != 4:
        raise ValueError("The model did not return all four stem outputs during a test inference.")
    expected_shape = (1, channels, chunk_samples)
    for stem_name, output in zip(("vocals", "drums", "bass", "other"), outputs):
        try:
            array = np.asarray(output)
        except Exception as error:
            raise ValueError(
                "The model returned an invalid " + stem_name + " output during test inference."
            ) from error
        if array.dtype != np.dtype(np.float32):
            raise ValueError(
                "The model returned a non-float32 " + stem_name + " output during test inference."
            )
        if array.shape != expected_shape:
            raise ValueError(
                "The model returned an invalid " + stem_name + " output shape during test inference."
            )
        if not np.isfinite(array).all():
            raise ValueError(
                "The model returned non-finite " + stem_name + " values during test inference."
            )


def inspect(manifest_path):
    np, ort, _, manifest, session = load_runtime(manifest_path)
    run_inference_smoke_test(np, manifest, session)
    print(
        json.dumps(
            {
                "compatible": True,
                "message": "Compatible. One bounded synthetic chunk passed local CPU inference.",
                "runtimeVersion": ort.__version__,
                "modelId": manifest["modelId"],
            }
        ),
        flush=True,
    )

def run_inference_smoke_test(np, manifest, session):
    stem_names = ("vocals", "drums", "bass", "other")
    expected_shape = (
        1,
        manifest["channels"],
        manifest["chunkSamples"],
    )
    outputs_requested = [
        manifest["outputNames"][name] for name in stem_names
    ]
    synthetic_audio = np.zeros(expected_shape, dtype=np.float32)

    try:
        outputs = session.run(
            outputs_requested,
            {manifest["inputName"]: synthetic_audio},
        )
    except Exception as error:
        detail = str(error).strip() or type(error).__name__
        raise RuntimeError(
            "Inference smoke test failed while processing one synthetic audio chunk: "
            + detail
        ) from error

    try:
        output_count = len(outputs)
    except (TypeError, AttributeError):
        output_count = None
    if output_count != len(stem_names):
        actual = "no output tensors" if output_count is None else str(output_count)
        raise ValueError(
            "Inference smoke test returned malformed four-stem outputs: "
            "expected 4 output tensors, received " + actual + "."
        )

    for stem_name, output in zip(stem_names, outputs):
        try:
            output_array = np.asarray(output)
        except Exception as error:
            raise ValueError(
                "Inference smoke test returned a malformed "
                + stem_name
                + " output tensor."
            ) from error

        actual_shape = tuple(getattr(output_array, "shape", ()))
        if actual_shape != expected_shape:
            raise ValueError(
                "Inference smoke test returned a malformed "
                + stem_name
                + " output: expected shape "
                + str(list(expected_shape))
                + ", received "
                + str(list(actual_shape))
                + "."
            )

        try:
            all_values_are_finite = np.isfinite(output_array).all()
        except Exception as error:
            raise ValueError(
                "Inference smoke test found invalid values in the "
                + stem_name
                + " output."
            ) from error
        if not all_values_are_finite:
            raise ValueError(
                "Inference smoke test found invalid values in the "
                + stem_name
                + " output; every sample must be finite."
            )
def separate(manifest_path, input_path, output_directory):
    np, _, sf, manifest, session = load_runtime(manifest_path)
    emit_progress(2, "Reading local audio…")
    audio, source_rate = sf.read(input_path, dtype="float32", always_2d=True)
    if audio.size == 0:
        raise ValueError("The selected audio file has no audio samples.")
    if not np.isfinite(audio).all():
        raise ValueError("The selected audio contains invalid sample values.")
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    elif audio.shape[1] > 2:
        audio = audio[:, :2]
    if source_rate != manifest["sampleRate"]:
        emit_progress(4, "Converting audio to 44.1 kHz for the model…")
        target_frames = max(
            1, round(len(audio) * manifest["sampleRate"] / source_rate)
        )
        old_positions = np.arange(len(audio), dtype=np.float64)
        new_positions = np.arange(target_frames, dtype=np.float64) * (
            source_rate / manifest["sampleRate"]
        )
        converted = np.empty((target_frames, 2), dtype=np.float32)
        for channel in range(2):
            converted[:, channel] = np.interp(
                new_positions, old_positions, audio[:, channel]
            ).astype(np.float32)
        audio = converted
    channel_first = np.ascontiguousarray(audio.T, dtype=np.float32)
    del audio

    total_samples = channel_first.shape[1]
    chunk_samples = manifest["chunkSamples"]
    overlap = min(16384, chunk_samples // 8)
    hop = chunk_samples - 2 * overlap
    starts = list(range(0, total_samples, hop))
    accumulated = {
        name: np.zeros((2, total_samples), dtype=np.float32)
        for name in ("vocals", "drums", "bass", "other")
    }
    weight_sum = np.zeros(total_samples, dtype=np.float32)
    os.makedirs(output_directory, exist_ok=True)

    for index, start in enumerate(starts):
        valid = min(chunk_samples, total_samples - start)
        sample = np.zeros((1, 2, chunk_samples), dtype=np.float32)
        sample[0, :, :valid] = channel_first[:, start : start + valid]
        outputs = session.run(
            [
                manifest["outputNames"][name]
                for name in ("vocals", "drums", "bass", "other")
            ],
            {manifest["inputName"]: sample},
        )
        weights = np.ones(valid, dtype=np.float32)
        fade = min(2 * overlap, valid)
        if start > 0 and fade > 0:
            weights[:fade] = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        if start + valid < total_samples and fade > 0:
            weights[-fade:] = np.minimum(
                weights[-fade:], np.linspace(1.0, 0.0, fade, dtype=np.float32)
            )
        weight_sum[start : start + valid] += weights
        for name, output in zip(("vocals", "drums", "bass", "other"), outputs):
            predicted = np.asarray(output, dtype=np.float32).reshape(2, chunk_samples)
            accumulated[name][:, start : start + valid] += (
                predicted[:, :valid] * weights[None, :]
            )
        emit_progress(
            5 + (index + 1) * 90 / len(starts),
            "Separating audio chunk " + str(index + 1) + " of " + str(len(starts)),
        )

    np.maximum(weight_sum, 1e-8, out=weight_sum)
    for name in ("vocals", "drums", "bass", "other"):
        output = (accumulated[name] / weight_sum[None, :]).T
        output = np.clip(output, -1.0, 1.0)
        sf.write(
            os.path.join(output_directory, name + ".wav"),
            output,
            manifest["sampleRate"],
            subtype="PCM_16",
        )
        del output
        emit_progress(
            95 + ("vocals", "drums", "bass", "other").index(name),
            "Writing " + name + " stem to the local cache…",
        )
    emit_progress(100, "All four synchronized stems are ready.")


class ModelDownloadProgress:
    def __init__(self, filename, index, total, start=0, span=100):
        self.filename = filename
        self.index = index
        self.total = total
        self.start = start
        self.span = span
        self.buffer = ""
        self.last_percent = 0

    def report(self, percent):
        self.last_percent = max(self.last_percent, min(100, percent))
        overall = self.start + self.span * (
            self.index + self.last_percent / 100
        ) / self.total
        emit_progress(
            overall,
            "Downloading model file "
            + str(self.index + 1)
            + " of "
            + str(self.total)
            + " · "
            + self.filename
            + " · "
            + str(self.last_percent)
            + "%",
        )

    def write(self, text):
        self.buffer += str(text)
        parts = re.split(r"[\r\n]+", self.buffer)
        self.buffer = parts.pop()
        for line in parts:
            percentage = re.search(r"(\d{1,3})%", line)
            if percentage:
                self.report(int(percentage.group(1)))
        return len(text)

    def flush(self):
        if self.buffer:
            text = self.buffer
            self.buffer = ""
            self.write(text + "\n")

    def isatty(self):
        return False


def retryable_model_download_error(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        status = getattr(getattr(error, "response", None), "status_code", None)
        if status is not None:
            return status == 429 or 500 <= status < 600
        if isinstance(error, (ConnectionError, TimeoutError)) or type(error).__name__ in (
            "ConnectionError", "ConnectError", "ReadTimeout", "ConnectTimeout",
            "Timeout", "ReadError", "RemoteProtocolError", "ChunkedEncodingError",
        ):
            return True
        error = error.__cause__ or error.__context__
    return False


def cached_model_path(repo_id, filename):
    from huggingface_hub import try_to_load_from_cache

    cached = try_to_load_from_cache(repo_id, filename)
    if isinstance(cached, str):
        path = Path(cached)
        if path.is_file() and path.stat().st_size > 0:
            return path
    return None


def model_weights_cached(model_name, precision):
    hub = importlib.import_module("demucs_onnx._hub")
    return all(
        cached_model_path(repo_id, filename) is not None
        for repo_id, filename in _model_repository_files(hub, model_name, precision)
    )


def prepare_model_weights(model_name, precision, start=0, span=100):
    bundled = bundled_model_paths(model_name, precision)
    if bundled is not None:
        emit_progress(start + span, "Model weights are included in the offline bundle.")
        return bundled

    hub = importlib.import_module("demucs_onnx._hub")
    entries = _model_repository_files(hub, model_name, precision)
    paths = {}
    for index, (repo_id, filename) in enumerate(entries):
        reporter = ModelDownloadProgress(filename, index, len(entries), start, span)
        reporter.report(0)
        for attempt in range(3):
            try:
                path = cached_model_path(repo_id, filename)
                if path is None:
                    with redirect_stdout(reporter), redirect_stderr(reporter):
                        path = Path(hub._hub_download(repo_id, filename))
                reporter.flush()
                if not path.is_file() or path.stat().st_size == 0:
                    raise RuntimeError("The downloaded model file is missing or empty: " + filename)
                paths[(repo_id, filename)] = path
                reporter.report(100)
                break
            except Exception as error:
                reporter.flush()
                if attempt == 2 or not retryable_model_download_error(error):
                    raise RuntimeError(
                        "Could not prepare " + filename + ": " + str(error)
                        + ". Retry the model download; completed files remain in the local cache."
                    ) from error
                emit_progress(
                    start + span * (index + reporter.last_percent / 100) / len(entries),
                    "Connection interrupted for " + filename
                    + "; retrying (" + str(attempt + 2) + "/3)…",
                )
                time.sleep(2 ** attempt)
    return paths


def is_directml_memory_error(error):
    messages = []
    seen = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        messages.append(str(current))
        current = current.__cause__ or current.__context__

    message = "\n".join(messages).lower()
    is_directml = any(
        marker in message
        for marker in ("directml", "dmlfusednode", "dmlexecutionprovider")
    )
    is_memory = any(
        marker in message
        for marker in (
            "8007000e",
            "not enough memory",
            "out of memory",
            "insufficient memory",
        )
    )
    return is_directml and is_memory


def _run_uvr_with_provider_fallback(provider, operation):
    try:
        return operation(provider), provider, None
    except Exception as accelerator_error:
        if provider != "DmlExecutionProvider":
            raise
        failure = str(accelerator_error).strip() or type(accelerator_error).__name__
        reason = (
            "DirectML ran out of memory"
            if is_directml_memory_error(accelerator_error)
            else "DirectML could not complete inference"
        )
        del accelerator_error
        gc.collect()
        try:
            result = operation("CPUExecutionProvider")
            return result, "CPUExecutionProvider", (reason, failure)
        except Exception as cpu_error:
            detail = str(cpu_error).strip() or type(cpu_error).__name__
            raise RuntimeError(
                reason + " (" + failure + "), and the CPU retry failed: " + detail
            ) from None


def validate_uvr_overlap(value):
    try:
        overlap = float(value)
    except (TypeError, ValueError):
        raise ValueError("Choose a supported UVR overlap setting.") from None
    if overlap not in UVR_OVERLAPS:
        raise ValueError("Choose a supported UVR overlap setting.")
    return overlap


def _uvr_model_cache_directory():
    configured = os.environ.get("CRATEFORGE_UVR_MODEL_DIR")
    if configured:
        return Path(configured)
    fallback = os.environ.get("HF_HOME")
    if fallback:
        return Path(fallback) / "uvr"
    raise RuntimeError("The local UVR model cache is unavailable.")


def _uvr_bundled_model_path():
    model_root = os.environ.get("CRATEFORGE_STEM_MODELS")
    if not model_root:
        return None
    root = Path(os.path.realpath(model_root))
    if not root.is_dir():
        raise RuntimeError("The bundled UVR model folder is missing.")
    return root / "uvr" / UVR_MODEL_FILENAME


def _sha256_file(path):
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as model_file:
        for chunk in iter(lambda: model_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _uvr_model_is_valid(path):
    try:
        return (
            path.is_file()
            and path.stat().st_size == UVR_MODEL_SIZE
            and _sha256_file(path) == UVR_MODEL_SHA256
        )
    except OSError:
        return False


def _cached_uvr_model_path():
    bundled_path = _uvr_bundled_model_path()
    if bundled_path is not None:
        if bundled_path.exists():
            if not _uvr_model_is_valid(bundled_path):
                raise RuntimeError(
                    "The bundled UVR model failed its SHA-256 check. Repair or reinstall the offline bundle."
                )
            return bundled_path, True
        manifest = bundled_path.parent.parent / "bundle-manifest.json"
        if manifest.is_file():
            raise RuntimeError(
                "The offline bundle is missing the UVR model file. Repair or reinstall the offline bundle."
            )

    local_path = _uvr_model_cache_directory() / UVR_MODEL_FILENAME
    if local_path.exists():
        if not _uvr_model_is_valid(local_path):
            raise RuntimeError(
                "The cached UVR model failed its SHA-256 check. Download the model again."
            )
        return local_path, False
    return None, False


def _uvr_runtime_modules():
    runtime = os.environ.get("CRATEFORGE_STEM_RUNTIME")
    if not runtime or not os.path.isdir(runtime):
        raise RuntimeError(
            "The bundled stem runtime is missing. Repair or reinstall Drop Theory Pro."
        )
    try:
        import numpy as np
        import onnxruntime as ort
        import soundfile as sf
        import soxr
    except ImportError as error:
        raise RuntimeError(
            "The bundled UVR inference or audio packages are incomplete. Repair or reinstall Drop Theory Pro."
        ) from error
    for label, module in (
        ("NumPy", np),
        ("ONNX Runtime", ort),
        ("SoundFile", sf),
        ("soxr", soxr),
    ):
        if not _path_is_within(getattr(module, "__file__", None), runtime):
            raise RuntimeError(
                "The bundled " + label + " package could not be loaded. Repair or reinstall Drop Theory Pro."
            )
    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("The bundled ONNX Runtime has no CPU execution provider.")
    return np, ort, sf, soxr


def _uvr_provider(ort):
    available = ort.get_available_providers()
    if os.name == "nt" and "DmlExecutionProvider" in available:
        return "DmlExecutionProvider"
    if "CUDAExecutionProvider" in available:
        return "CUDAExecutionProvider"
    return "CPUExecutionProvider"


def _new_uvr_session(ort, model_path, provider):
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        str(model_path), sess_options=options, providers=[provider]
    )
    input_info = next(
        (item for item in session.get_inputs() if item.name == "input"), None
    )
    output_info = next(
        (item for item in session.get_outputs() if item.name == "output"), None
    )
    expected = [4, UVR_FREQ_BINS, UVR_SEGMENT_FRAMES]
    if input_info is None or input_info.type != "tensor(float)":
        raise ValueError("The UVR model input is not the expected float32 tensor.")
    if output_info is None or output_info.type != "tensor(float)":
        raise ValueError("The UVR model output is not the expected float32 tensor.")
    for label, info in (("input", input_info), ("output", output_info)):
        if len(info.shape) != 4 or any(
            isinstance(actual, int) and actual != expected[index]
            for index, actual in enumerate(info.shape[1:])
        ):
            raise ValueError(
                "The UVR model " + label + " dimensions do not match the HQ5 model."
            )
    return session


def _uvr_spectrogram(np, audio, window):
    padded = np.pad(
        audio,
        ((0, 0), (UVR_N_FFT // 2, UVR_N_FFT // 2)),
        mode="reflect",
    )
    frames = np.lib.stride_tricks.sliding_window_view(
        padded, UVR_N_FFT, axis=-1
    )[:, ::UVR_HOP_LENGTH, :]
    spectrum = np.fft.rfft(frames * window[None, None, :], axis=-1)
    spectrum = spectrum.transpose(0, 2, 1)
    planes = np.stack((spectrum.real, spectrum.imag), axis=1)
    return np.ascontiguousarray(
        planes.reshape(1, 4, UVR_N_FFT // 2 + 1, -1)[
            :, :, :UVR_FREQ_BINS, :
        ],
        dtype=np.float32,
    )


def _uvr_inverse_spectrogram(np, prediction, window):
    if prediction.shape != (
        1,
        4,
        UVR_FREQ_BINS,
        UVR_SEGMENT_FRAMES,
    ):
        raise ValueError("The UVR model returned an invalid spectrogram shape.")
    if not np.isfinite(prediction).all():
        raise ValueError("The UVR model returned non-finite spectrogram values.")
    planes = prediction[0].reshape(2, 2, UVR_FREQ_BINS, UVR_SEGMENT_FRAMES)
    full_spectrum = np.zeros(
        (2, UVR_N_FFT // 2 + 1, UVR_SEGMENT_FRAMES), dtype=np.complex64
    )
    full_spectrum[:, :UVR_FREQ_BINS, :] = planes[:, 0] + 1j * planes[:, 1]
    frames = np.fft.irfft(
        full_spectrum.transpose(0, 2, 1), n=UVR_N_FFT, axis=-1
    ).astype(np.float32)
    frames *= window[None, None, :]
    output_length = UVR_HOP_LENGTH * (UVR_SEGMENT_FRAMES - 1) + UVR_N_FFT
    output = np.zeros((2, output_length), dtype=np.float32)
    window_sum = np.zeros(output_length, dtype=np.float32)
    window_squared = window * window
    for index in range(UVR_SEGMENT_FRAMES):
        start = index * UVR_HOP_LENGTH
        end = start + UVR_N_FFT
        output[:, start:end] += frames[:, index, :]
        window_sum[start:end] += window_squared
    output /= np.maximum(window_sum[None, :], 1e-8)
    trim = UVR_N_FFT // 2
    return np.ascontiguousarray(output[:, trim:-trim], dtype=np.float32)


def _run_uvr_chunk(np, session, audio, window):
    model_input = _uvr_spectrogram(np, audio, window)
    model_input[:, :, :3, :] = 0
    prediction = session.run(["output"], {"input": model_input})[0]
    prediction = np.asarray(prediction, dtype=np.float32)
    return _uvr_inverse_spectrogram(np, prediction, window)


def _separate_uvr_chunks(np, session, audio, overlap):
    chunk_size = UVR_HOP_LENGTH * (UVR_SEGMENT_FRAMES - 1)
    trim = UVR_N_FFT // 2
    generation_size = chunk_size - 2 * trim
    if generation_size <= 0:
        raise RuntimeError("The configured UVR model chunk is too short.")
    padding = generation_size + trim - (audio.shape[1] % generation_size)
    mixture = np.concatenate(
        (
            np.zeros((2, trim), dtype=np.float32),
            audio,
            np.zeros((2, padding), dtype=np.float32),
        ),
        axis=1,
    )
    step = max(1, int((1.0 - overlap) * chunk_size))
    starts = range(0, mixture.shape[1], step)
    result = np.zeros_like(mixture)
    divider = np.zeros(mixture.shape[1], dtype=np.float32)
    window = (0.5 - 0.5 * np.cos(
        2.0 * np.pi * np.arange(UVR_N_FFT, dtype=np.float32) / UVR_N_FFT
    )).astype(np.float32)
    chunks = len(starts)

    for index, start in enumerate(starts):
        end = min(start + chunk_size, mixture.shape[1])
        valid = end - start
        chunk = mixture[:, start:end]
        if valid < chunk_size:
            chunk = np.pad(chunk, ((0, 0), (0, chunk_size - valid)))
        separated = _run_uvr_chunk(np, session, chunk, window)
        weights = np.hanning(valid).astype(np.float32) if overlap > 0 else np.ones(
            valid, dtype=np.float32
        )
        result[:, start:end] += separated[:, :valid] * weights[None, :]
        divider[start:end] += weights
        emit_progress(
            8 + (index + 1) * 82 / chunks,
            "Separating UVR audio chunk " + str(index + 1) + " of " + str(chunks),
        )

    result /= np.maximum(divider[None, :], 1e-8)
    return np.ascontiguousarray(result[:, trim : trim + audio.shape[1]])


def inspect_uvr_model():
    np, ort, _, _ = _uvr_runtime_modules()
    model_path, bundled = _cached_uvr_model_path()
    provider = _uvr_provider(ort)
    message = (
        "UVR runtime ready. Download the 59 MB HQ5 model before separating audio."
        if model_path is None
        else "Checking the cached UVR model with local inference…"
    )
    if model_path is not None:
        probe_length = UVR_HOP_LENGTH * (UVR_SEGMENT_FRAMES - 1)
        probe_time = np.arange(probe_length, dtype=np.float32) / UVR_SAMPLE_RATE
        probe_audio = np.random.default_rng(0).normal(
            0.0, 0.025, size=(2, probe_length)
        ).astype(np.float32)
        probe_audio[0] += (
            0.08 * np.sin(2.0 * np.pi * 440.0 * probe_time)
            + 0.03 * np.sin(2.0 * np.pi * 1100.0 * probe_time)
        )
        probe_audio[1] += (
            0.07 * np.sin(2.0 * np.pi * 330.0 * probe_time)
            + 0.04 * np.sin(2.0 * np.pi * 880.0 * probe_time)
        )
        probe_window = (
            0.5
            - 0.5
            * np.cos(
                2.0
                * np.pi
                * np.arange(UVR_N_FFT, dtype=np.float32)
                / UVR_N_FFT
            )
        ).astype(np.float32)
        sample = _uvr_spectrogram(np, probe_audio, probe_window)
        sample[:, :, :3, :] = 0
        if not np.any(np.abs(sample) > 1e-8):
            raise ValueError("The non-silent UVR inference probe became empty.")

        def run_probe(probe_provider):
            session = _new_uvr_session(ort, model_path, probe_provider)
            output = np.asarray(session.run(["output"], {"input": sample})[0])
            if (
                output.shape != sample.shape
                or not np.isfinite(output).all()
                or not np.any(np.abs(output) > 1e-8)
            ):
                raise ValueError(
                    "The UVR model failed its non-silent local inference check."
                )

        preferred_provider = provider
        _, provider, fallback = _run_uvr_with_provider_fallback(provider, run_probe)
        if provider == preferred_provider:
            message = (
                "Runtime and verified UVR HQ5 model passed a non-silent inference check."
            )
        else:
            message = (
                "UVR HQ5 passed a non-silent CPU inference check after DirectML failed."
            )
    print(
        json.dumps(
            {
                "compatible": True,
                "message": message,
                "runtimeVersion": ort.__version__,
                "modelId": "UVR-MDX-NET-Inst_HQ_5",
                "modelsBundled": bool(model_path is not None and bundled),
                "modelsCached": model_path is not None,
                "executionProvider": provider,
                "modelLicense": "MIT",
                "weightsLicense": "MIT",
            }
        ),
        file=PROTOCOL_STDOUT,
        flush=True,
    )


def download_uvr_model():
    import urllib.request

    _uvr_runtime_modules()
    cached, _ = _cached_uvr_model_path()
    if cached is not None:
        emit_progress(100, "The verified UVR model is already available locally.")
        return

    directory = _uvr_model_cache_directory()
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / UVR_MODEL_FILENAME
    partial = directory / (UVR_MODEL_FILENAME + ".part")
    if destination.exists():
        destination.unlink()

    for attempt in range(3):
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > UVR_MODEL_SIZE:
            partial.unlink()
            offset = 0
        if offset == UVR_MODEL_SIZE:
            if _uvr_model_is_valid(partial):
                os.replace(partial, destination)
                emit_progress(100, "The verified UVR model is ready locally.")
                return
            partial.unlink()
            offset = 0

        headers = {"User-Agent": "Drop-Theory-Pro/1.0"}
        if offset:
            headers["Range"] = "bytes=" + str(offset) + "-"
        request = urllib.request.Request(UVR_MODEL_URL, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                status = getattr(response, "status", response.getcode())
                append = offset > 0 and status == 206
                if append:
                    content_range = response.headers.get("Content-Range", "")
                    if not content_range.startswith("bytes " + str(offset) + "-"):
                        raise RuntimeError(
                            "The UVR model server returned an invalid resume range."
                        )
                else:
                    offset = 0
                mode = "ab" if append else "wb"
                received = offset
                with open(partial, mode) as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                        received += len(chunk)
                        if received > UVR_MODEL_SIZE:
                            raise RuntimeError(
                                "The UVR model download exceeded its pinned size."
                            )
                        emit_progress(
                            min(99, received * 100 / UVR_MODEL_SIZE),
                            "Downloading UVR HQ5 model · "
                            + str(received * 100 // UVR_MODEL_SIZE)
                            + "%",
                        )
                    output.flush()
                    os.fsync(output.fileno())
            if partial.stat().st_size != UVR_MODEL_SIZE:
                raise ConnectionError(
                    "The model download was interrupted and can be resumed."
                )
            if _sha256_file(partial) != UVR_MODEL_SHA256:
                partial.unlink(missing_ok=True)
                raise RuntimeError(
                    "The UVR model SHA-256 check failed. The downloaded file was discarded."
                )
            os.replace(partial, destination)
            emit_progress(100, "The UVR HQ5 model passed its SHA-256 check.")
            return
        except RuntimeError:
            raise
        except Exception as error:
            if attempt == 2:
                raise RuntimeError(
                    "Could not download the UVR HQ5 model after three attempts: "
                    + str(error)
                ) from error
            time.sleep(2 ** (attempt + 1))


def _fit_audio_length(np, audio, expected_frames):
    if audio.shape[0] < expected_frames:
        audio = np.pad(
            audio,
            ((0, expected_frames - audio.shape[0]), (0, 0)),
        )
    return np.ascontiguousarray(audio[:expected_frames], dtype=np.float32)


def separate_uvr_model(overlap_value, input_path, output_directory):
    np, ort, sf, soxr = _uvr_runtime_modules()
    overlap = validate_uvr_overlap(overlap_value)
    model_path, _ = _cached_uvr_model_path()
    if model_path is None:
        download_uvr_model()
        model_path, _ = _cached_uvr_model_path()
    if model_path is None:
        raise RuntimeError("The verified UVR model is not available locally.")

    emit_progress(1, "Loading the verified UVR HQ5 model…")
    provider = _uvr_provider(ort)
    emit_progress(3, "Reading local audio…")
    source_audio, source_rate = sf.read(
        input_path, dtype="float32", always_2d=True
    )
    if source_audio.size == 0:
        raise ValueError("The selected audio file has no audio samples.")
    if source_rate <= 0 or not np.isfinite(source_audio).all():
        raise ValueError("The selected audio has an invalid sample rate or samples.")
    if source_audio.shape[1] == 1:
        source_audio = np.repeat(source_audio, 2, axis=1)
    elif source_audio.shape[1] > 2:
        source_audio = source_audio[:, :2]
    source_audio = np.ascontiguousarray(source_audio, dtype=np.float32)
    original_frames = source_audio.shape[0]
    if source_rate == UVR_SAMPLE_RATE:
        model_audio = source_audio
    else:
        emit_progress(5, "Resampling audio for the UVR model…")
        model_audio = soxr.resample(
            source_audio, source_rate, UVR_SAMPLE_RATE, quality="HQ", axis=0
        )
    model_audio = np.ascontiguousarray(model_audio.T, dtype=np.float32)

    def separate_with_provider(selected_provider):
        if selected_provider != provider:
            emit_progress(
                8,
                "DirectML could not complete inference; retrying the full separation on CPU. This may take longer…",
            )
        session = _new_uvr_session(ort, model_path, selected_provider)
        return _separate_uvr_chunks(np, session, model_audio, overlap)

    separated_instrumental, _, _ = _run_uvr_with_provider_fallback(
        provider, separate_with_provider
    )

    instrumental = separated_instrumental.T
    if source_rate != UVR_SAMPLE_RATE:
        instrumental = soxr.resample(
            instrumental,
            UVR_SAMPLE_RATE,
            source_rate,
            quality="HQ",
            axis=0,
        )
        instrumental = _fit_audio_length(np, instrumental, original_frames)
    vocals = source_audio - instrumental
    os.makedirs(output_directory, exist_ok=True)
    emit_progress(94, "Writing synchronized vocals and instrumental stems…")
    sf.write(
        os.path.join(output_directory, "vocals.wav"),
        np.clip(vocals, -1.0, 1.0),
        source_rate,
        subtype="PCM_16",
    )
    sf.write(
        os.path.join(output_directory, "instrumental.wav"),
        np.clip(instrumental, -1.0, 1.0),
        source_rate,
        subtype="PCM_16",
    )
    emit_progress(100, "UVR vocals and instrumental stems are ready.")


def download_pretrained(model_name, precision):
    load_local_runtime_modules()
    prepare_model_weights(model_name, precision)
    emit_progress(100, "Selected model weights are ready for offline use.")


class ProgressCapture:
    def __init__(self, model_name, models_bundled=False, progress_floor=0):
        self.model_name = model_name
        self.models_bundled = models_bundled
        self.buffer = ""
        self.chunk_total = None
        self.last_chunk = 0
        self.model_pass = 0
        self.saw_chunk = False
        self.progress_floor = min(94, max(0, int(progress_floor)))
        self.last_percent = self.progress_floor

    def write(self, text):
        self.buffer += str(text)
        parts = re.split(r"[\r\n]+", self.buffer)
        self.buffer = parts.pop()
        for line in parts:
            self._report_line(line)
        return len(text)

    def flush(self):
        if self.buffer:
            self._report_line(self.buffer)
            self.buffer = ""

    def isatty(self):
        return False

    def _report_line(self, line):
        chunk = re.search(r"chunk\s+(\d+)\s*/\s*(\d+)", line, re.IGNORECASE)
        if chunk:
            current = int(chunk.group(1))
            total = max(1, int(chunk.group(2)))
            if self.chunk_total is None:
                self.chunk_total = total
            if self.saw_chunk and current <= self.last_chunk and self.model_name == "htdemucs_ft":
                self.model_pass = min(3, self.model_pass + 1)
            self.last_chunk = current
            self.saw_chunk = True
            pass_count = 4 if self.model_name == "htdemucs_ft" else 1
            done = self.model_pass * total + current
            progress_start = max(8, self.progress_floor)
            percent = progress_start + round(
                (94 - progress_start) * done / (total * pass_count)
            )
            percent = min(94, max(self.last_percent, percent))
            self.last_percent = percent
            emit_progress(
                percent,
                "Separating audio · chunk " + str(current) + " of " + str(total),
            )
            return

        if not self.saw_chunk and not self.models_bundled:
            percentage = re.search(r"(\d{1,3})%", line)
            if percentage:
                downloaded = max(0, min(100, int(percentage.group(1))))
                emit_progress(
                    1 + round(downloaded * 6 / 100),
                    "Downloading model weights to the local cache…",
                )
            elif re.search(r"download|fetch|model file", line, re.IGNORECASE):
                emit_progress(2, "Downloading model weights to the local cache…")


def inspect_pretrained(model_name, precision):
    demucs_onnx, ort = load_local_runtime_modules()

    if model_name not in ("htdemucs_ft", "htdemucs"):
        raise ValueError("Unsupported built-in model profile.")
    if precision not in ("fp32", "fp16weights"):
        raise ValueError("Unsupported built-in model precision.")
    if model_name not in demucs_onnx.list_models():
        raise RuntimeError(
            "The installed demucs-onnx runtime does not list the selected model."
        )
    models_bundled = bundled_model_paths(model_name, precision, demucs_onnx) is not None
    models_cached = models_bundled or model_weights_cached(model_name, precision)
    available_providers = ort.get_available_providers()
    if "CPUExecutionProvider" not in available_providers:
        raise RuntimeError("The installed ONNX Runtime has no CPU execution provider.")
    if os.name == "nt" and "DmlExecutionProvider" in available_providers:
        execution_provider = "DmlExecutionProvider"
    elif "CUDAExecutionProvider" in available_providers:
        execution_provider = "CUDAExecutionProvider"
    elif "CoreMLExecutionProvider" in available_providers:
        execution_provider = "CoreMLExecutionProvider"
    else:
        execution_provider = "CPUExecutionProvider"

    print(
        json.dumps(
            {
                "compatible": True,
                "message": (
                    "Runtime and selected model weights are ready for offline use."
                    if models_cached
                    else "Runtime ready. Model weights download to this device on first use."
                ),
                "runtimeVersion": ort.__version__,
                "packageVersion": demucs_onnx.__version__,
                "modelId": model_name,
                "precision": precision,
                "modelsBundled": models_bundled,
                "modelsCached": models_cached,
                "executionProvider": execution_provider,
            }
        ),
        file=PROTOCOL_STDOUT,
        flush=True,
    )


def separate_pretrained(model_name, precision, input_path, output_directory):
    try:
        import numpy as np
        import soundfile as sf
    except ImportError as error:
        raise RuntimeError(
            "The bundled audio packages are incomplete. Repair or reinstall Drop Theory Pro."
        ) from error
    demucs_onnx, ort = load_local_runtime_modules()

    if model_name not in ("htdemucs_ft", "htdemucs"):
        raise ValueError("Unsupported built-in model profile.")
    if precision not in ("fp32", "fp16weights"):
        raise ValueError("Unsupported built-in model precision.")
    if "CPUExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("The installed ONNX Runtime has no CPU execution provider.")
    models_bundled = bundled_model_paths(model_name, precision, demucs_onnx) is not None

    sample_rate = sf.info(input_path).samplerate
    os.makedirs(output_directory, exist_ok=True)
    emit_progress(
        1,
        "Loading the bundled model files…"
        if models_bundled
        else "Preparing model; first use downloads weights to this device…",
    )
    prepared_paths = prepare_model_weights(model_name, precision, start=1, span=6)
    hub = importlib.import_module("demucs_onnx._hub")
    original_download = hub._hub_download

    def prepared_download(repo_id, filename, *, cache_dir=None, token=None):
        path = prepared_paths.get((repo_id, filename))
        if path is None:
            raise RuntimeError("The selected model requested an unprepared weight file.")
        return path

    hub._hub_download = prepared_download
    reporter = ProgressCapture(
        model_name,
        models_bundled=models_bundled,
        progress_floor=7,
    )
    retry_on_cpu = False
    try:
        try:
            with redirect_stdout(reporter), redirect_stderr(reporter):
                separated = demucs_onnx.separate(
                    input_path,
                    model=model_name,
                    precision=precision,
                    providers="auto",
                    verbose=True,
                    progress=False,
                )
        except Exception as error:
            if not is_directml_memory_error(error):
                reporter.flush()
                raise
            # Keep only the retry decision. Retaining the exception retains its
            # traceback frames and can keep failed DirectML sessions alive.
            retry_on_cpu = True
        if retry_on_cpu:
            reporter.flush()
            progress_floor = min(94, max(1, reporter.last_percent))
            emit_progress(
                progress_floor,
                "DirectML ran out of memory; retrying this separation on CPU. This may take longer…",
            )
            cpu_reporter = ProgressCapture(
                model_name,
                models_bundled=models_bundled,
                progress_floor=progress_floor,
            )
            try:
                demucs_onnx.session_pool().clear()
                gc.collect()
                with redirect_stdout(cpu_reporter), redirect_stderr(cpu_reporter):
                    separated = demucs_onnx.separate(
                        input_path,
                        model=model_name,
                        precision=precision,
                        providers="cpu",
                        verbose=True,
                        progress=False,
                    )
            except Exception as cpu_error:
                cpu_reporter.flush()
                detail = str(cpu_error).strip() or type(cpu_error).__name__
                raise RuntimeError(
                    "DirectML ran out of memory, and retrying on CPU failed: " + detail
                ) from None
            reporter = cpu_reporter
    finally:
        hub._hub_download = original_download
    reporter.flush()

    stem_names = ("vocals", "drums", "bass", "other")
    missing = [name for name in stem_names if name not in separated]
    if missing:
        raise ValueError("The selected model did not return all four stems: " + ", ".join(missing))

    emit_progress(95, "Writing synchronized stem files to the local cache…")
    for index, name in enumerate(stem_names):
        audio = np.asarray(separated[name], dtype=np.float32)
        if audio.ndim != 2 or audio.shape[0] != 2:
            raise ValueError("The model returned an invalid stereo " + name + " stem.")
        if not np.isfinite(audio).all():
            raise ValueError("The model returned non-finite samples in the " + name + " stem.")
        sf.write(
            os.path.join(output_directory, name + ".wav"),
            np.clip(audio.T, -1.0, 1.0),
            sample_rate,
            subtype="PCM_16",
        )
        emit_progress(96 + index, "Saved " + name + " stem locally…")
    emit_progress(100, "All four synchronized stems are ready.")


def main():
    try:
        configure_local_runtime()
        mode = sys.argv[1]
        if mode == "inspect":
            inspect(sys.argv[2])
        elif mode == "separate":
            separate(sys.argv[2], sys.argv[3], sys.argv[4])
        elif mode == "inspect-pretrained":
            inspect_pretrained(sys.argv[2], sys.argv[3])
        elif mode == "download-pretrained":
            download_pretrained(sys.argv[2], sys.argv[3])
        elif mode == "separate-pretrained":
            separate_pretrained(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
        elif mode == "inspect-uvr":
            inspect_uvr_model()
        elif mode == "download-uvr":
            download_uvr_model()
        elif mode == "separate-uvr":
            separate_uvr_model(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            raise ValueError("Unknown local stem runner command.")
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        if os.environ.get("CRATEFORGE_STEM_DEBUG") == "1":
            traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
