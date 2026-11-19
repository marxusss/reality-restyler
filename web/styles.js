// Own the style catalog, editor, selection state and event handlers.
export function mountStyles({promptInput, applyPromptNow, request, getRenderedFrame, isMirrored}) {
  const $ = id => document.getElementById(id);
  const stylesDialog = $("stylesDialog");
  const styleEditor = $("styleEditor");
  const styleForm = $("styleForm");
  const styleName = $("styleName");
  const stylePrompt = $("stylePrompt");
  const styleCapturePreview = $("styleCapturePreview");
  const styleEditorError = $("styleEditorError");
  const customStyleStorageKey = "reality-restyle-custom-styles";

  let styleSelection = null;
  let appliedStyleSelection = { prompt: "", styles: [] };
  let editingStyleIndex = -1;
  const maxStyles = 5;

  function setStyleError(element, message = "") {
    element.textContent = message;
    element.hidden = !message;
  }

  function customStyles() {
    try {
      const styles = JSON.parse(localStorage.getItem(customStyleStorageKey) || "[]");
      if (Array.isArray(styles)) return styles;
    } catch (_) {}
    return [];
  }

  function updateStyleSelection() {
    const combining = styleSelection !== null;
    $("combineStylesButton").setAttribute("aria-pressed", String(combining));
    $("addStyleButton").hidden = combining;
    $("useStylesButton").hidden = !combining;
    $("useStylesButton").disabled = !styleSelection?.length;
    for (const card of stylesDialog.querySelectorAll(".style-card")) {
      const selected = styleSelection?.includes(card.dataset.prompt) ?? false;
      if (combining) card.setAttribute("aria-pressed", String(selected));
      else card.removeAttribute("aria-pressed");
      card.disabled = styleSelection?.length === maxStyles && !selected;
    }
  }

  function setStyleSelection(selection) {
    styleSelection = selection;
    setStyleError($("styleCombineError"));
    updateStyleSelection();
  }

  function startStyleSelection() {
    return promptInput.value === appliedStyleSelection.prompt ? [...appliedStyleSelection.styles] : [];
  }

  function applyStyleSelection(prompt, styles) {
    appliedStyleSelection = { prompt, styles };
    promptInput.value = prompt;
    applyPromptNow();
    stylesDialog.close();
  }

  async function useStyleSelection() {
    const selection = styleSelection;
    if (!selection?.length) return;
    $("useStylesButton").disabled = true;
    setStyleError($("styleCombineError"));
    try {
      const { prompt } = await request("/styles/combine", { prompts: selection });
      if (stylesDialog.open && styleSelection === selection) applyStyleSelection(prompt, selection);
    } catch (error) {
      if (styleSelection === selection) setStyleError($("styleCombineError"), error.message);
    } finally {
      if (styleSelection === selection) updateStyleSelection();
    }
  }

  function renderStyleCards(container, styles, editable = false) {
    const cards = styles.map((style, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "style-card";
      button.dataset.prompt = style.prompt;
      const thumbnail = document.createElement("span");
      thumbnail.className = "style-thumbnail";
      if (style.thumbnail) {
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        image.src = style.thumbnail;
        thumbnail.append(image);
      }
      const label = document.createElement("span");
      label.textContent = style.name;
      button.append(thumbnail, label);
      button.addEventListener("click", event => {
        if (styleSelection === null && !event.shiftKey) {
          applyStyleSelection(style.prompt, [style.prompt]);
          return;
        }
        const selected = styleSelection ?? startStyleSelection();
        if (selected.includes(style.prompt)) {
          setStyleSelection(selected.filter(prompt => prompt !== style.prompt));
        } else if (selected.length < maxStyles) {
          setStyleSelection([...selected, style.prompt]);
        } else {
          setStyleSelection(selected);
        }
      });
      if (!editable) return button;
      const card = document.createElement("div");
      card.className = "custom-style-card";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "style-edit-button";
      edit.setAttribute("aria-label", `Edit ${style.name}`);
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4.5-1 10.2-10.2a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z"/></svg>';
      edit.addEventListener("click", () => openStyleEditor(style, index));
      card.append(button, edit);
      return card;
    });
    container.replaceChildren(...cards);
    updateStyleSelection();
  }

  function renderCustomStyles() {
    const styles = customStyles();
    $("customStyleSection").hidden = !styles.length;
    renderStyleCards($("customStyles"), styles, true);
  }

  async function openStyles() {
    const presetStyles = $("presetStyles");
    const catalogError = $("catalogError");
    setStyleSelection(null);
    renderCustomStyles();
    stylesDialog.showModal();
    if (presetStyles.hasChildNodes()) return;
    setStyleError(catalogError);
    try {
      const response = await fetch("/styles/catalog.json");
      if (!response.ok) throw new Error();
      renderStyleCards(presetStyles, await response.json());
    } catch (_) {
      setStyleError(catalogError, "Could not load styles.");
    }
  }

  function openStyleEditor(style = null, index = -1) {
    editingStyleIndex = index;
    styleForm.reset();
    $("styleEditorTitle").textContent = style ? "Edit style" : "Add style";
    styleName.value = style?.name || "";
    stylePrompt.value = style?.prompt ?? promptInput.value;
    if (style?.thumbnail) {
      styleCapturePreview.src = style.thumbnail;
      styleCapturePreview.hidden = false;
    } else {
      styleCapturePreview.removeAttribute("src");
      styleCapturePreview.hidden = true;
    }
    setStyleError(styleEditorError);
    styleEditor.showModal();
  }

  function captureStyle() {
    setStyleError(styleEditorError);
    const {frame, width, height} = getRenderedFrame() || {};
    if (!width || !height) {
      setStyleError(styleEditorError, "No AI frame available to capture.");
      return;
    }
    try {
      const thumbnail = document.createElement("canvas");
      const scale = Math.min(1, 320 / Math.max(width, height));
      thumbnail.width = Math.max(1, Math.round(width * scale));
      thumbnail.height = Math.max(1, Math.round(height * scale));
      const context = thumbnail.getContext("2d", { alpha: false });
      if (isMirrored()) {
        context.translate(thumbnail.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(frame, 0, 0, thumbnail.width, thumbnail.height);
      styleCapturePreview.src = thumbnail.toDataURL("image/webp", 0.78);
      styleCapturePreview.hidden = false;
    } catch (_) {
      setStyleError(styleEditorError, "Could not capture the AI frame.");
    }
  }

  function saveStyle(event) {
    event.preventDefault();
    const name = styleName.value.trim();
    const prompt = stylePrompt.value;
    if (!name || !prompt.trim()) {
      setStyleError(styleEditorError, "Enter a name and prompt.");
      return;
    }
    const styles = customStyles();
    const style = { name, prompt, thumbnail: styleCapturePreview.getAttribute("src") };
    const savedIndex = editingStyleIndex;
    const previous = savedIndex >= 0 ? styles[savedIndex] : null;
    if (savedIndex < 0) styles.unshift(style);
    else if (previous) styles[savedIndex] = style;
    else {
      setStyleError(styleEditorError, "Could not find the style to update.");
      return;
    }
    if (previous && styleSelection?.includes(previous.prompt)) {
      styleSelection = styleSelection.map(selected => selected === previous.prompt ? prompt : selected);
    }
    try {
      localStorage.setItem(customStyleStorageKey, JSON.stringify(styles));
    } catch (_) {
      setStyleError(styleEditorError, "Could not save the style on this device.");
      return;
    }
    styleEditor.close();
    renderCustomStyles();
    if (savedIndex < 0) $("styleList").scrollTop = 0;
    const savedCard = $("customStyles").querySelectorAll(".custom-style-card")[savedIndex < 0 ? 0 : savedIndex];
    savedCard?.querySelector(savedIndex < 0 ? ".style-card" : ".style-edit-button")?.focus();
  }


  $("stylesButton").addEventListener("click", () => void openStyles());
  $("combineStylesButton").addEventListener("click", () => setStyleSelection(styleSelection === null ? startStyleSelection() : null));
  $("useStylesButton").addEventListener("click", () => void useStyleSelection());
  $("closeStylesButton").addEventListener("click", () => stylesDialog.close());
  $("addStyleButton").addEventListener("click", () => openStyleEditor());
  $("closeStyleEditorButton").addEventListener("click", () => styleEditor.close());
  $("captureStyleButton").addEventListener("click", captureStyle);
  styleForm.addEventListener("submit", saveStyle);
}
