import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from runtime import PROMPT_CACHE_SIZE, Runtime, combine_style_prompts
from runtime_settings import DEFAULT_SETTINGS, normalize_settings
from timing import TimingWindow


class RuntimeSettingsTests(unittest.TestCase):
    def test_cpu_offload_is_explicitly_configured(self):
        import os
        from runtime import _cpu_offload_enabled

        for value, expected in ((None, False), ("0", False), ("1", True), ("true", True)):
            with self.subTest(value=value):
                if value is None:
                    with patch.dict(os.environ, {}, clear=True):
                        self.assertEqual(_cpu_offload_enabled(), expected)
                else:
                    with patch.dict(os.environ, {"REALITY_RESTYLE_CPU_OFFLOAD": value}, clear=True):
                        self.assertEqual(_cpu_offload_enabled(), expected)

    def test_style_combination_preserves_every_instruction(self):
        first = "Pencil drawing; keep scene intact"
        second = "Bold watercolor, keep scene intact"
        with patch("runtime.prompt_token_count", return_value=24):
            prompt, tokens = combine_style_prompts([first, second])
        self.assertIn(first, prompt)
        self.assertIn(second, prompt)
        self.assertLess(prompt.index(first), prompt.index(second))
        self.assertEqual(prompt.count("keep scene intact"), 2)
        self.assertEqual(tokens, 24)

    def test_defaults_keep_optional_upscaler_enabled(self):
        settings = normalize_settings({})
        self.assertEqual(settings, DEFAULT_SETTINGS)
        self.assertTrue(settings["upscale"])
        self.assertEqual(settings["resolution"], 512)
        self.assertEqual(settings["upscaler"], "spanv2x4")

    def test_partial_updates_preserve_other_values(self):
        updated = normalize_settings({"steps": 3}, {"prompt": "portrait", "steps": 4, "resolution": 640, "upscale": True, "upscaler": "spanv2x4", "rotation": 90})
        self.assertEqual(updated["steps"], 3)
        self.assertEqual(updated["prompt"], "portrait")
        self.assertEqual(updated["rotation"], 90)
        self.assertEqual(updated["upscaler"], "spanv2x4")

    def test_rejects_unknown_model_and_runtime_controls(self):
        for payload in ({"model": "other"}, {"seed": 4}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                normalize_settings(payload)

    def test_rejects_invalid_ranges_and_boolean_integers(self):
        for payload in ({"steps": 0}, {"steps": True}, {"resolution": 600}, {"resolution": 640.0}, {"rotation": 45}, {"rotation": 90.0}):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    normalize_settings(payload)

    def test_cold_prompt_encode_uses_inference_mode(self):
        import torch

        class FakePipe:
            def __init__(self):
                self.calls = 0
                self.inference_mode = False
                self.transformer = type("Transformer", (), {"dtype": torch.bfloat16})()

            def encode_prompt(self, **kwargs):
                self.calls += 1
                self.inference_mode = torch.is_inference_mode_enabled()
                return torch.ones((1, 1), dtype=torch.float16), None

        runtime = Runtime()
        runtime._pipe = FakePipe()
        with patch("torch.cuda.is_available", return_value=True), patch("torch.cuda.set_device"), patch("torch.cuda.synchronize") as synchronize:
            embeds, _ = runtime._encode_prompt("test prompt")
            cached, _ = runtime._encode_prompt("test prompt")
        self.assertTrue(runtime._pipe.inference_mode)
        self.assertTrue(torch.is_inference(embeds))
        self.assertEqual(embeds.dtype, torch.bfloat16)
        self.assertIs(embeds, cached)
        self.assertEqual(runtime._pipe.calls, 1)
        synchronize.assert_called_once_with()

    def test_prompt_cache_is_bounded_and_keeps_recent_prompts(self):
        import torch

        class FakePipe:
            def __init__(self):
                self.calls = 0
                self.transformer = type("Transformer", (), {"dtype": torch.bfloat16})()

            def encode_prompt(self, **kwargs):
                self.calls += 1
                return torch.full((1, 1), self.calls, dtype=torch.bfloat16), None

        runtime = Runtime()
        runtime._pipe = FakePipe()
        with patch("torch.cuda.set_device"):
            for index in range(PROMPT_CACHE_SIZE):
                runtime._encode_prompt(f"prompt {index}")
            runtime._encode_prompt("prompt 0")
            self.assertEqual(runtime._pipe.calls, PROMPT_CACHE_SIZE)
            runtime._encode_prompt("new prompt")
            self.assertEqual(len(runtime._prompt_cache), PROMPT_CACHE_SIZE)
            runtime._encode_prompt("prompt 1")
            self.assertEqual(runtime._pipe.calls, PROMPT_CACHE_SIZE + 2)

    def test_status_reads_do_not_wait_for_inference_lock(self):
        from concurrent.futures import ThreadPoolExecutor
        runtime = Runtime()
        runtime._pipe = object()
        with ThreadPoolExecutor(max_workers=1) as executor:
            with runtime._lock:
                self.assertTrue(executor.submit(runtime.metrics).result(timeout=1)["loaded"])
                self.assertTrue(executor.submit(runtime.loaded).result(timeout=1))

    def test_render_never_returns_an_unprocessed_frame(self):
        runtime = Runtime()
        with self.assertRaisesRegex(RuntimeError, "not loaded"):
            runtime.render(None)

    def test_settings_reject_oversized_prompt_without_changing_previous_settings(self):
        runtime = Runtime()
        runtime.set_settings({"prompt": "portrait"})
        with self.assertRaises(ValueError):
            runtime.set_settings({"prompt": "x" * 2001})
        self.assertEqual(runtime.settings()["prompt"], "portrait")


class TimingWindowTests(unittest.TestCase):
    def test_p95_is_hidden_for_small_windows(self):
        window = TimingWindow("test", size=30)
        for value in range(1, 20):
            window.record(value_ms=value)
        output = StringIO()
        with redirect_stdout(output):
            window.flush()
        self.assertIn("frames=19", output.getvalue())
        self.assertIn("value_ms_p95=n/a", output.getvalue())
        self.assertIn("value_ms_avg=10.0", output.getvalue())

    def test_p95_is_reported_with_twenty_samples(self):
        window = TimingWindow("test", size=30)
        for value in range(1, 21):
            window.record(value_ms=value)
        output = StringIO()
        with redirect_stdout(output):
            window.flush()
        self.assertIn("frames=20", output.getvalue())
        self.assertIn("value_ms_p95=19.0", output.getvalue())

    def test_prompt_encoding_window_reports_prompt_samples(self):
        window = TimingWindow("prompt_encode_cold", sample_label="prompts")
        window.record(prompt_encode_wall_ms=123)
        output = StringIO()
        with redirect_stdout(output):
            window.flush()
        self.assertIn("path=prompt_encode_cold prompts=1", output.getvalue())

if __name__ == "__main__":
    unittest.main()
