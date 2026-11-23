// Custom styles are persisted and merged on the PC, not in the browser.
export function mountStyles({promptInput, applyPromptNow, request, getRenderedFrame, isMirrored, fitPrompt = () => {}, closeSettings}) {
  const $ = id => document.getElementById(id);
  const stylesDialog = $("stylesDialog");
  const styleEditor = $("styleEditor");
  const styleForm = $("styleForm");
  const styleName = $("styleName");
  const stylePrompt = $("stylePrompt");
  const styleCapturePreview = $("styleCapturePreview");
  const deleteStyleButton = $("deleteStyleButton");
  const styleEditorError = $("styleEditorError");

  let styleSelection = null;
  let appliedStyleSelection = { prompt: "", styles: [] };
  let editingStyleId = null;
  let customStylesSync = Promise.resolve();
  let syncedStyles = [];
  const maxStyles = 5;

  function setStyleError(element, message = "") {
    element.textContent = message;
    element.hidden = !message;
  }

  function syncCustomStyles(newStyle = null) {
    // The PC is the only persistent store and already resolves edit conflicts.
    // Serialize requests so saves cannot race with the initial load or each other.
    const operation = customStylesSync.then(async () => {
      const {styles} = await request("/styles/user", newStyle === null ? undefined : {styles: [newStyle]});
      syncedStyles = styles;
      setStyleError($("styleStorageError"));
      renderCustomStyles();
      return syncedStyles;
    }).catch(error => {
      setStyleError($("styleStorageError"), "Could not sync custom styles.");
      throw error;
    });
    customStylesSync = operation.catch(() => {});
    return operation;
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
    fitPrompt();
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
    const cards = styles.map(style => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "style-card";
      button.dataset.prompt = style.prompt;
      button.title = style.name;
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
      label.className = "style-name";
      label.textContent = style.name;
      thumbnail.append(label);
      button.append(thumbnail);
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
      edit.addEventListener("click", () => openStyleEditor(style));
      card.append(button, edit);
      return card;
    });
    container.replaceChildren(...cards);
    updateStyleSelection();
  }

  function renderCustomStyles() {
    const styles = syncedStyles.filter(style => !style.deleted);
    $("customStyleSection").hidden = !styles.length;
    renderStyleCards($("customStyles"), styles, true);
  }

  async function openStyles() {
    if (stylesDialog.open) {
      stylesDialog.close();
      return;
    }
    const presetStyles = $("presetStyles");
    const catalogError = $("catalogError");
    setStyleSelection(null);
    renderCustomStyles();
    closeSettings();
    stylesDialog.show();
    for (const button of [$("stylesButton"), $("quickStylesButton")]) {
      button.setAttribute("aria-expanded", "true");
    }
    void syncCustomStyles().catch(() => {});
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

  function openStyleEditor(style = null) {
    editingStyleId = style?.id || null;
    deleteStyleButton.hidden = !editingStyleId;
    styleForm.reset();
    $("styleEditorTitle").textContent = style ? "Edit Style" : "Add Style";
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
      const aspectRatio = 8 / 5;
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = width;
      let sourceHeight = height;
      if (width / height > aspectRatio) {
        sourceWidth = height * aspectRatio;
        sourceX = (width - sourceWidth) / 2;
      } else {
        sourceHeight = width / aspectRatio;
        sourceY = (height - sourceHeight) / 2;
      }
      const scale = Math.min(1, 320 / sourceWidth, 200 / sourceHeight);
      thumbnail.width = Math.max(1, Math.round(sourceWidth * scale));
      thumbnail.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = thumbnail.getContext("2d", { alpha: false });
      if (isMirrored()) {
        context.translate(thumbnail.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(frame, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, thumbnail.width, thumbnail.height);
      styleCapturePreview.src = thumbnail.toDataURL("image/webp", 0.78);
      styleCapturePreview.hidden = false;
    } catch (_) {
      setStyleError(styleEditorError, "Could not capture the AI frame.");
    }
  }

  async function deleteStyle() {
    const previous = editingStyleId ? syncedStyles.find(item => item.id === editingStyleId && !item.deleted) : null;
    if (!previous || !window.confirm(`Delete "${previous.name}"? This removes it from synced devices.`)) return;
    deleteStyleButton.disabled = true;
    try {
      await syncCustomStyles({
        id: previous.id,
        deleted: true,
        updatedAt: Math.max(Date.now(), previous.updatedAt + 1)
      });
      styleEditor.close();
    } catch (_) {
      setStyleError(styleEditorError, "Could not delete the style.");
    } finally {
      deleteStyleButton.disabled = false;
    }
  }

  async function saveStyle(event) {
    event.preventDefault();
    const save = styleForm.querySelector('button[type="submit"]');
    if (save.disabled) return;
    const name = styleName.value.trim();
    const prompt = stylePrompt.value;
    if (!name || !prompt.trim()) {
      setStyleError(styleEditorError, "Enter a name and prompt.");
      return;
    }
    const previous = editingStyleId ? syncedStyles.find(item => item.id === editingStyleId) : null;
    const style = {
      id: editingStyleId || (crypto.randomUUID ? crypto.randomUUID() : `style-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name,
      prompt,
      thumbnail: styleCapturePreview.getAttribute("src"),
      updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1)
    };
    editingStyleId = style.id;
    save.disabled = true;
    try {
      await syncCustomStyles(style);
    } catch (_) {
      setStyleError(styleEditorError, "Could not save the style.");
      return;
    } finally {
      save.disabled = false;
    }
    if (previous && styleSelection?.includes(previous.prompt)) {
      styleSelection = styleSelection.map(selected => selected === previous.prompt ? prompt : selected);
    }
    styleEditor.close();
    renderCustomStyles();
    const visibleIndex = syncedStyles.filter(item => !item.deleted).findIndex(item => item.id === style.id);
    const savedCard = $("customStyles").querySelectorAll(".custom-style-card")[visibleIndex];
    savedCard?.querySelector(".style-edit-button")?.focus();
  }


  const updateStylesExpanded = () => {
    const expanded = String(stylesDialog.open);
    for (const button of [$("stylesButton"), $("quickStylesButton")]) {
      button.setAttribute("aria-expanded", expanded);
    }
  };
  stylesDialog.addEventListener("close", updateStylesExpanded);
  $("stylesButton").addEventListener("click", () => void openStyles());
  $("quickStylesButton").addEventListener("click", () => void openStyles());
  $("combineStylesButton").addEventListener("click", () => setStyleSelection(styleSelection === null ? startStyleSelection() : null));
  $("useStylesButton").addEventListener("click", () => void useStyleSelection());
  $("closeStylesButton").addEventListener("click", () => stylesDialog.close());
  $("addStyleButton").addEventListener("click", () => openStyleEditor());
  $("closeStyleEditorButton").addEventListener("click", () => styleEditor.close());
  $("captureStyleButton").addEventListener("click", captureStyle);
  deleteStyleButton.addEventListener("click", () => void deleteStyle());
  styleForm.addEventListener("submit", event => { void saveStyle(event); });
  void syncCustomStyles().catch(() => {});
}
