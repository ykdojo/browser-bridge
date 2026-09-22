const $ = (id) => document.getElementById(id);

function show(s) {
  $("version").textContent = "v" + s.version;
  $("dot").className = s.connected ? "on" : "";
  $("state").textContent = s.connected
    ? "Connected to a local agent server."
    : "No agent server is running. It starts with a session in your MCP client, and the extension finds it within seconds.";
}

const ask = (type) => chrome.runtime.sendMessage({ type }).then(show);
$("about").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("about.html") });
});
ask("status");
