import importlib.util
import unittest
from unittest.mock import patch

import model_setup

HAS_TORCH = importlib.util.find_spec("torch") is not None
needs_torch = unittest.skipUnless(HAS_TORCH, "needs torch, which this machine does not have installed")


class ModelVariantTests(unittest.TestCase):
    @needs_torch
    def test_ampere_uses_int4_and_blackwell_uses_fp4(self):
        with patch("torch.cuda.is_available", return_value=True), \
             patch("model_setup.best_cuda_device", return_value=1):
            with patch("torch.cuda.get_device_capability", return_value=(8, 6)):
                self.assertEqual(model_setup.selected_transformer(), model_setup.INT4_TRANSFORMER_NAME)
            with patch("torch.cuda.get_device_capability", return_value=(12, 0)):
                self.assertEqual(model_setup.selected_transformer(), model_setup.TRANSFORMER_NAME)
