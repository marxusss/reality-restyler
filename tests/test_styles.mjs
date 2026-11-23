import {test} from "node:test";
import assert from "node:assert/strict";
import {mountStyles} from "../src/web/styles.js";

function fakeElement() {
  return {
    dataset: {},
    events: {},
    children: [],
    hidden: false,
    disabled: false,
    value: "",
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute() {},
    removeAttribute() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || fakeElement(); },
    querySelectorAll(selector) { return selector === ".custom-style-card" ? this.children.filter(child => child.className === "custom-style-card") : []; },
    focus() { this.focused = true; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    reset() {},
    getAttribute() { return null; }
  };
}

test("custom styles load and save through the PC", async () => {
  const previousDocument = globalThis.document;
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  globalThis.document = {getElementById: get, createElement: fakeElement};
  const requests = [];
  // A prior deletion remains in the host store but is not rendered as a card.
  let stored = [{id: "deleted-first", deleted: true, updatedAt: Date.now() + 100000}];
  try {
    mountStyles({
      promptInput: get("promptInput"),
      applyPromptNow() {},
      getRenderedFrame() { return null; },
      isMirrored() { return false; },
      request: async (path, body) => {
        assert.equal(path, "/styles/user");
        requests.push(body ? {method: "POST", body} : {method: "GET"});
        if (body) stored = [...stored, ...body.styles];
        return {styles: stored};
      }
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [{method: "GET"}]);
    get("addStyleButton").events.click();
    get("styleName").value = "Example";
    get("stylePrompt").value = "watercolor";
    get("styleForm").events.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "POST");
    assert.equal(requests[1].body.styles.length, 1);
    assert.equal(requests[1].body.styles[0].name, "Example");
    assert.equal(stored.length, 2);
    assert.equal(get("customStyles").children.length, 1);
    assert.equal(get("customStyles").children[0].children[1].focused, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
