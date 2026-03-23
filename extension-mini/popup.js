const RELEASES = "https://github.com/olegperegudov/snatch/releases/latest";

chrome.runtime.sendMessage({ type: "check_health" }, (res) => {
  const dot = document.getElementById("dot");
  const label = document.getElementById("label");
  const install = document.getElementById("install");

  if (res && res.ok) {
    dot.className = "dot ok";
    label.className = "label ok";
    label.textContent = `connected v${res.version || "?"}`;
  } else {
    dot.className = "dot";
    label.className = "label";
    label.textContent = "not connected";
    install.style.display = "block";
    document.getElementById("dl-link").href = RELEASES;
  }
});
