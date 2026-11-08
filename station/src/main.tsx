import { createRoot } from "react-dom/client";
import { App } from "./listener/App.tsx";
import "./listener/themes/afterglow.css";
import "./listener/themes/theset.css";

createRoot(document.getElementById("root")!).render(<App />);
