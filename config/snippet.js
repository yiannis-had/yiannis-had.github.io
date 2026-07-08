function toggleSnippet(btn) {
  const section = btn.closest(".snippet-section");
  const body = section.querySelector(".snippet-body");
  const isOpen = body.classList.toggle("open");
  btn.innerHTML = isOpen ? "&#9660;" : "&#9654;";
}

function copySnippet(btn) {
  const section = btn.closest(".snippet-section");
  const pre = section.querySelector("pre");
  const text = pre.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
    }, 1500);
  });
}
