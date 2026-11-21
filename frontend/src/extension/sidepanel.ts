import { createApp } from "vue";
import SidePanelApp from "./SidePanelApp.vue";
import "./sidepanel.css";
import { applyCachedExtensionTheme } from "./uiTargetHelpers";

function mountSidePanel() {
  applyCachedExtensionTheme();
  const root = document.getElementById("app");
  if (!root) return;
  createApp(SidePanelApp).mount(root);
}

if (typeof document !== "undefined") {
  mountSidePanel();
}
