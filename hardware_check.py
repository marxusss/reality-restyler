"""Advisory NVIDIA VRAM check. No installs, GPU whitelist, or hard failures."""
import json
import subprocess

SIMULTANEOUS_VRAM_GIB = 24


def best_cuda_device(torch):
    return max(range(torch.cuda.device_count()),
               key=lambda index: torch.cuda.get_device_properties(index).total_memory)


def assess(gpus):
    if not gpus:
        return {"status": "unknown", "message": "NVIDIA CUDA GPU not detected. This Windows app does not support AMD or Apple GPUs."}
    name, mib = max(gpus, key=lambda gpu: gpu[1])
    vram = round(mib / 1024, 1)
    if vram < SIMULTANEOUS_VRAM_GIB:
        return {"status": "limited", "gpu": name, "vram_gb": vram,
                "message": f"{name}: {vram:g} GiB VRAM. Model and text encoder may not fit together. CPU offloading can help but may be slower; operation is not guaranteed."}
    return {"status": "ready", "gpu": name, "vram_gb": vram, "message": f"{name}: {vram:g} GiB VRAM."}


def probe():
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
        gpus = []
        for line in output.splitlines():
            name, mib = line.rsplit(",", 1)
            gpus.append((name.strip(), int(mib.strip())))
        return assess(gpus)
    except (OSError, ValueError, subprocess.SubprocessError):
        return assess([])


if __name__ == "__main__":
    print(json.dumps(probe()))
