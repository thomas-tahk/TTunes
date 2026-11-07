import { createRoot } from "react-dom/client";
import { App } from "./listener/App.tsx";
import "./listener/styles.css";

createRoot(document.getElementById("root")!).render(<App />);
