const $ = (id) => document.getElementById(id);

function show(s) {
  $("version").textContent = "v" + s.version;
  $("dot").className = s.connected ? "on" : "";
  $("state").textContent = s.connected
    ? "Connected to a local agent server."
    : "No agent server is running. It starts with a session in your MCP client, and the extension finds it within seconds.";
  // Only worth showing when a server has said another profile is the one in use.
  const other = s.connected && s.isActive === false;
  $("profile").style.display = other ? "flex" : "none";
  $("which").textContent = "Agents are using another Chrome profile.";
}

const ask = (type) => chrome.runtime.sendMessage({ type }).then(show);
$("use").addEventListener("click", () => ask("activate").then(() => setTimeout(() => ask("status"), 300)));
$("about").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("about.html") });
});
ask("status");
