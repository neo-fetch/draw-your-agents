import { Canvas } from "./canvas/Canvas.tsx";
import { Inspector } from "./inspector/Inspector.tsx";
import { Preview } from "./preview/Preview.tsx";
import { Toolbar } from "./toolbar/Toolbar.tsx";

export function App() {
  return (
    <div className="app-shell">
      <Toolbar />
      <div className="app">
        <section className="pane">
          <header>Canvas</header>
          <Canvas />
        </section>
        <section className="pane">
          <header>Inspector</header>
          <div className="body inspector">
            <Inspector />
          </div>
        </section>
        <section className="pane">
          <header>Preview</header>
          <div className="body preview">
            <Preview />
          </div>
        </section>
      </div>
    </div>
  );
}
