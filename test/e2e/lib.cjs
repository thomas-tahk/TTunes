// Shared helpers for the Playwright e2e drivers in this folder.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const FIXTURES = join(__dirname, "..", "fixtures");

const load = (fixture, name, type) => ({ name, type, base64: readFileSync(join(FIXTURES, fixture)).toString("base64") });

// Dispatches a real `drop` DragEvent on window with a DataTransfer holding the files, in order.
async function dropFiles(page, files) {
  await page.evaluate((specs) => {
    const dt = new DataTransfer();
    for (const s of specs) {
      const bytes = Uint8Array.from(atob(s.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], s.name, { type: s.type }));
    }
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

module.exports = { FIXTURES, load, dropFiles };
