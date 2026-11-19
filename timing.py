"""Rolling measurement summaries shared by inference and transports."""
import time

class TimingWindow:
    def __init__(self, path, size=30, sample_label="frames", p95_min_samples=20):
        self.path = path
        self.size = size
        self.sample_label = sample_label
        self.p95_min_samples = p95_min_samples
        self.samples = []
        self.context = {}

    def record(self, context=None, **values):
        context = dict(context or {})
        if self.samples and context != self.context:
            self.flush()
        self.context = context
        self.samples.append({name: float(value) for name, value in values.items()})
        if len(self.samples) >= self.size:
            self.flush()

    def flush(self):
        if not self.samples:
            return
        samples = self.samples
        self.samples = []
        fields = []
        for name in samples[0]:
            values = sorted(sample[name] for sample in samples)
            p95 = (
                f"{name}_p95={values[min(len(values) - 1, max(0, int(len(values) * 0.95 + 0.999) - 1))]:.1f}"
                if len(values) >= self.p95_min_samples else f"{name}_p95=n/a"
            )
            fields.extend((
                f"{name}_avg={sum(values) / len(values):.1f}",
                p95,
                f"{name}_max={values[-1]:.1f}",
            ))
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%S")
        context = " ".join(f"{name}={value}" for name, value in self.context.items())
        suffix = f" {context}" if context else ""
        print(f"TIMING {timestamp} path={self.path} {self.sample_label}={len(samples)}{suffix} {' '.join(fields)}", flush=True)
        self.context = {}

