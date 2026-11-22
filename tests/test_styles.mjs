import {test} from "node:test";
import assert from "node:assert/strict";
import {mountStyles} from "../web/styles.js";

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
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    reset() {},
    getAttribute() { return null; }
  };
}

test("custom styles load and save through the PC without browser storage", async () => {
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  globalThis.document = {getElementById: get, createElement: fakeElement};
  globalThis.localStorage = new Proxy({}, {
    get() { throw new Error("Browser storage must not be used for custom styles."); },
    set() { throw new Error("Browser storage must not be used for custom styles."); }
  });
  const requests = [];
  let stored = [];
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
    assert.equal(stored.length, 1);
    assert.equal(get("customStyles").children.length, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});
