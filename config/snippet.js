document.querySelectorAll(".snippet-section").forEach((section, index) => {
  const body = section.querySelector(".snippet-body");
  const toggle = section.querySelector(".toggle-btn");
  body.id = `snippet-${index}`;
  toggle.setAttribute("aria-controls", body.id);
  toggle.setAttribute("aria-expanded", body.classList.contains("open"));
  section.querySelector(".copy-btn").setAttribute("aria-live", "polite");
});

function toggleSnippet(btn) {
  const body = btn.closest(".snippet-section").querySelector(".snippet-body");
  const isOpen = body.classList.toggle("open");
  btn.textContent = isOpen ? "▼" : "▶";
  btn.setAttribute("aria-expanded", isOpen);
}

async function copySnippet(btn) {
  const text = btn.closest(".snippet-section").querySelector("pre").textContent;
  btn.disabled = true;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied!";
    btn.classList.add("copied");
  } catch {
    btn.textContent = "Copy failed";
  } finally {
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
      btn.disabled = false;
    }, 1500);
  }
}
