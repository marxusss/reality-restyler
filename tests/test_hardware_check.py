import unittest
from unittest.mock import patch

import hardware_check


class HardwareAdvisoryTests(unittest.TestCase):
    def test_low_vram_is_a_warning_not_a_failure(self):
        result = hardware_check.assess([("RTX 3070", 8192)])
        self.assertEqual(result["status"], "limited")
        self.assertIn("offloading", result["message"].lower())

    def test_selects_largest_gpu_independently_of_list_order(self):
        result = hardware_check.assess([("Small", 8192), ("Large", 32768)])
        self.assertEqual(result["gpu"], "Large")
        self.assertEqual(result["status"], "ready")

    def test_cuda_selects_largest_total_vram(self):
        class Cuda:
            device_count = staticmethod(lambda: 2)
            get_device_properties = staticmethod(lambda index: type("Device", (), {"total_memory": [8, 32][index]})())
            get_device_capability = staticmethod(lambda index: (8, 6))

        self.assertEqual(hardware_check.best_cuda_device(type("Torch", (), {"cuda": Cuda})()), 1)

    def test_equal_vram_prefers_newer_architecture(self):
        class Cuda:
            device_count = staticmethod(lambda: 2)
            get_device_properties = staticmethod(lambda index: type("Device", (), {"total_memory": 8})())
            get_device_capability = staticmethod(lambda index: [(6, 1), (8, 6)][index])

        self.assertEqual(hardware_check.best_cuda_device(type("Torch", (), {"cuda": Cuda})()), 1)

    def test_undetected_gpu_reports_uncertainty(self):
        with patch("hardware_check.subprocess.run", side_effect=FileNotFoundError):
            result = hardware_check.probe()
        self.assertEqual(result["status"], "unknown")
