// app.js: what the page does. A shared counter, stored with workshop-data.js.
// Anyone can see the count; pressing saves, which needs the workshop's sign-in (workshop-data.js offers it).
"use strict";

const countText = document.getElementById("count");
const pressButton = document.getElementById("press");
const whoText = document.getElementById("who");
const statusText = document.getElementById("status");

let count = 0;
let lastBy = null;

function show(message) {
  countText.textContent = String(count);
  const me = workshopData.whoAmI();
  const parts = [];
  if (lastBy !== null) parts.push("Last press by " + lastBy + ".");
  if (me !== null) parts.push("You save as " + me + ".");
  whoText.textContent = parts.join(" ");
  statusText.textContent = message;
}

async function load() {
  try {
    const stored = await workshopData.getInfo("presses");
    count = typeof stored.value === "number" ? stored.value : 0;
    lastBy = stored.updatedBy;
    show("");
  } catch (error) {
    show(error.message);
  }
}

pressButton.addEventListener("click", async function () {
  pressButton.disabled = true;
  count += 1;
  show("Saving...");
  try {
    await workshopData.set("presses", count);
    lastBy = workshopData.whoAmI();
    show("Saved.");
  } catch (error) {
    count -= 1;
    show(error.message);
  } finally {
    pressButton.disabled = false;
  }
});

load();
