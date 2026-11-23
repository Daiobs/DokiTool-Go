import { createApp } from "vue";
import MonitorApp from "./MonitorApp.vue";
import "./monitor.css";
import { applyCachedExtensionTheme } from "./uiTargetHelpers";

function mountMonitorDashboard() {
  applyCachedExtensionTheme();
  const root = document.getElementById("app");
  if (!root) return;
  createApp(MonitorApp).mount(root);
}

if (typeof document !== "undefined") {
  mountMonitorDashboard();
}
