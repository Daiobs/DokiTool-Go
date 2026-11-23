import { createApp } from "vue";
import "./monitor.css";
import MonitorApp from "./MonitorApp.vue";
import {
  applyMonitorTheme,
  readMonitorTheme,
  stripUrlQueryAndHash,
} from "./monitorStorage";

stripUrlQueryAndHash();
applyMonitorTheme(readMonitorTheme());

createApp(MonitorApp).mount("#app");
