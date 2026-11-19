"""Persistent Windows control panel. GPU work lives in the server subprocess."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tkinter as tk
from tkinter import messagebox, ttk
import uuid
import webbrowser

from PIL import ImageTk
import qrcode
from log_retention import ROOT, LOG_DIR, prune_logs


class Launcher:
    def __init__(self, root):
        self.root = root
        self.process = None
        self.status_file = None
        self.stop_file = None
        self.stop_started = None
        self.closing = False
        self.mode = ""
        self.url = ""
        self.qr = None
        self.open_when_ready = False
        self.last_prune = 0.0
        root.title("Reality Restyler")
        root.geometry("450x545")
        root.minsize(410, 505)
        root.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(root)
        style.configure("Title.TLabel", font=("Segoe UI", 19, "bold"))
        style.configure("Subtitle.TLabel", foreground="#526276", font=("Segoe UI", 10))
        style.configure("Status.TLabel", font=("Segoe UI", 11))
        style.configure("Primary.TButton", font=("Segoe UI", 11, "bold"), padding=9)
        style.configure("TButton", padding=6)
        outer = ttk.Frame(root, padding=20)
        outer.pack(fill="both", expand=True)
        ttk.Label(outer, text="Reality Restyler", style="Title.TLabel").pack(anchor="w")
        ttk.Label(outer, text="Local AI camera • Windows host", style="Subtitle.TLabel").pack(anchor="w", pady=(2, 16))
        card = ttk.Labelframe(outer, text="Server", padding=12)
        card.pack(fill="x")
        self.status = tk.StringVar(value="Stopped")
        self.detail = tk.StringVar(value="Choose a connection mode to start.")
        ttk.Label(card, textvariable=self.status, style="Status.TLabel").pack(anchor="w")
        ttk.Label(card, textvariable=self.detail, wraplength=350).pack(anchor="w", pady=(5, 0))
        buttons = ttk.Frame(outer)
        buttons.pack(fill="x", pady=(14, 8))
        self.desktop = ttk.Button(buttons, text="Open desktop camera", style="Primary.TButton", command=lambda: self.start("desktop"))
        self.desktop.pack(side="left", fill="x", expand=True, padx=(0, 5))
        self.phone = ttk.Button(buttons, text="Connect phone", style="Primary.TButton", command=lambda: self.start("phone"))
        self.phone.pack(side="left", fill="x", expand=True, padx=(5, 0))
        self.connection = ttk.Labelframe(outer, text="Connection", padding=10)
        self.connection.pack(fill="both", expand=True)
        self.link = tk.StringVar(value="No server running.")
        ttk.Label(self.connection, textvariable=self.link, wraplength=350).pack(anchor="center", pady=(4, 8))
        self.qr_label = ttk.Label(self.connection)
        self.qr_label.pack(expand=True)
        self.copy = ttk.Button(self.connection, text="Copy link", command=self.copy_link, state="disabled")
        self.copy.pack(pady=4)
        bottom = ttk.Frame(outer)
        bottom.pack(fill="x", pady=(10, 0))
        ttk.Button(bottom, text="View logs", command=self.logs).pack(side="left")
        ttk.Button(bottom, text="Phone setup", command=lambda: webbrowser.open("https://login.tailscale.com/admin/dns")).pack(side="left", padx=6)
        self.stop_button = ttk.Button(bottom, text="Stop server", command=self.stop, state="disabled")
        self.stop_button.pack(side="right")
        self.tick()

    def logs(self):
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        os.startfile(str(LOG_DIR))

    def copy_link(self):
        if self.url:
            self.root.clipboard_clear()
            self.root.clipboard_append(self.url)

    def start(self, mode):
        if self.stop_started is not None:
            return
        if self.process is not None and self.process.poll() is None:
            if self.mode == mode and self.url:
                if mode == "desktop":
                    webbrowser.open(self.url)
                return
            if not messagebox.askyesno("Switch connection", "Stop the current server and switch modes? This unloads the AI model.", parent=self.root):
                return
            self.next_mode = mode
            self.stop()
            return
        if mode == "phone" and not messagebox.askyesno("Phone access", "Phone access requires Tailscale on both devices, MagicDNS and HTTPS certificates. A further confirmation will show your public certificate hostname.", parent=self.root):
            return
        self.next_mode = None
        ROOT.mkdir(parents=True, exist_ok=True)
        ident = uuid.uuid4().hex
        self.status_file = ROOT / f"launcher-{ident}.json"
        self.stop_file = ROOT / f"launcher-{ident}.stop"
        cmd = [sys.executable, "-u", str(Path(__file__).with_name("app.py")), "--launcher",
               "--status-file", str(self.status_file), "--stop-file", str(self.stop_file)]
        if mode == "phone":
            cmd.append("--phone-access")
        self.mode = mode
        self.open_when_ready = mode == "desktop"
        self.status.set("Starting…")
        self.detail.set("Checking network and starting the local server.")
        self.url = ""
        self.link.set("Waiting for server…")
        self.qr_label.configure(image="")
        self.qr = None
        self.copy.configure(state="disabled")
        self.desktop.configure(state="disabled")
        self.phone.configure(state="disabled")
        self.stop_button.configure(state="normal")
        try:
            self.process = subprocess.Popen(cmd, cwd=str(Path(__file__).parent),
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as exc:
            self.status.set("Could not start")
            self.detail.set(str(exc))
            self.reset()

    def reset(self):
        self.process = None
        self.stop_started = None
        for path in (self.status_file, self.stop_file):
            if path:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
        self.status_file = self.stop_file = None
        self.url = ""
        self.link.set("No server running.")
        self.qr_label.configure(image="")
        self.qr = None
        self.copy.configure(state="disabled")
        self.stop_button.configure(state="disabled")
        self.desktop.configure(state="normal")
        self.phone.configure(state="normal")

    def stop(self):
        if self.process is None or self.stop_started is not None:
            return
        self.stop_started = time.monotonic()
        self.status.set("Stopping…")
        self.detail.set("Closing the camera and releasing GPU memory.")
        self.stop_button.configure(state="disabled")
        self.desktop.configure(state="disabled")
        self.phone.configure(state="disabled")
        try:
            self.stop_file.touch()
        except OSError:
            self.process.terminate()

    def close(self):
        self.closing = True
        self.next_mode = None
        if self.process is None:
            self.root.destroy()
        else:
            self.stop()

    def display_ready(self, data):
        url = data.get("url", "")
        if not url.startswith(("http://127.0.0.1:", "https://")):
            return
        self.status.set("Running • " + self.mode.capitalize())
        model = "Model loaded" if data.get("loaded") else "Model not loaded"
        camera = "Camera connected" if data.get("connected") else "No active camera"
        self.detail.set(model + "  |  " + camera)
        self.desktop.configure(state="normal")
        self.phone.configure(state="normal")
        if self.url != url:
            self.url = url
            self.link.set(url)
            self.copy.configure(state="normal")
            if self.mode == "phone":
                image = qrcode.make(url).convert("RGB").resize((180, 180))
                self.qr = ImageTk.PhotoImage(image)
                self.qr_label.configure(image=self.qr)
            if self.open_when_ready:
                self.open_when_ready = False
                webbrowser.open(url)

    def tick(self):
        if time.monotonic() - self.last_prune >= 3600 or not self.last_prune:
            self.last_prune = time.monotonic()
            prune_logs()
        data = {}
        if self.status_file:
            try:
                data = json.loads(self.status_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        if self.process:
            if self.stop_started is not None and time.monotonic() - self.stop_started > 30:
                if self.process.poll() is None:
                    self.process.terminate()
            if self.process.poll() is not None:
                stopped = self.stop_started is not None
                code = self.process.returncode
                self.status.set("Stopped" if stopped or code == 0 else "Server stopped unexpectedly")
                self.detail.set(data.get("error") or ("Choose a connection mode to start." if stopped or code == 0 else "Check the logs, then retry."))
                self.reset()
                if self.closing:
                    self.root.destroy()
                    return
                if getattr(self, "next_mode", None):
                    mode, self.next_mode = self.next_mode, None
                    self.start(mode)
            elif self.stop_started is None:
                if data.get("ready"):
                    self.display_ready(data)
                elif data.get("error"):
                    self.status.set("Could not start")
                    self.detail.set(data["error"])
        self.root.after(500, self.tick)


if __name__ == "__main__":
    root = tk.Tk()
    Launcher(root)
    root.mainloop()
