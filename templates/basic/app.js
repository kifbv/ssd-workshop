// app.js: what the page does. A shared counter, stored with workshop-data.js.
// Anyone can see the count; pressing saves, which needs the app's edit link (workshopData.canSave()).
"use strict";

// Opened without the edit link: view only. style.css then hides every element with the class edit-only.
if (!workshopData.canSave()) document.body.classList.add("view-only");

const countText = document.getElementById("count");
const pressButton = document.getElementById("press");
const whoText = document.getElementById("who");
const statusText = document.getElementById("status");

let count = 0;
let lastBy = null;
let me = null;

function show(message) {
  countText.textContent = String(count);
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
    me = await workshopData.whoAmI();
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
    me = await workshopData.whoAmI();
    lastBy = me;
    show("Saved.");
  } catch (error) {
    count -= 1;
    me = await workshopData.whoAmI();
    show(error.message);
  } finally {
    pressButton.disabled = false;
  }
});

load();
