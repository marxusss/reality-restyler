// Home Screen app height. With viewport-fit=cover, iOS can leave a Home Screen app's layout viewport short of the
// screen by about the status bar (WebKit bug 237961), so 100dvh and `bottom` stop short. A Home Screen bookmark
// without a web manifest may also report display-mode "browser", so CSS alone cannot tell it apart from a tab.
// When the window spans the whole screen width, the app is full screen and its height is the screen's.

export function homeScreenHeight({ standalone, displayModeStandalone, innerWidth, innerHeight, screenWidth, screenHeight }) {
  if (!standalone && !displayModeStandalone) return 0;
  const long = Math.max(screenWidth, screenHeight);
  const short = Math.min(screenWidth, screenHeight);
  const landscape = innerWidth > innerHeight;
  const width = landscape ? long : short;
  const height = landscape ? short : long;
  // Split screen or a resized window: trust the window.
  if (Math.abs(innerWidth - width) > 1 || innerHeight > height) return innerHeight;
  return height;
}

export function mountHomeScreenHeight(win = window) {
  const root = win.document.documentElement;
  const displayMode = win.matchMedia?.("(display-mode: standalone)");
  const update = () => {
    const height = homeScreenHeight({
      standalone: win.navigator.standalone === true,
      displayModeStandalone: Boolean(displayMode?.matches),
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
      screenWidth: win.screen.width,
      screenHeight: win.screen.height
    });
    root.classList.toggle("home-screen-app", height > 0);
    if (height > 0) root.style.setProperty("--app-height", `${height}px`);
    else root.style.removeProperty("--app-height");
  };
  update();
  win.addEventListener("resize", update);
  win.addEventListener("orientationchange", update);
  return update;
}
