// Runs before first paint so a saved dark theme doesn't flash light.
try { if (localStorage.getItem("pennylog.theme") === "dark") document.documentElement.setAttribute("data-theme", "dark"); } catch (e) {}
