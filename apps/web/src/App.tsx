import { RouterProvider } from "react-router";
import { createAppRouter } from "./app/router.js";

const ROUTER = typeof document === "undefined" ? undefined : createAppRouter();

function App() {
  if (ROUTER === undefined) {
    return (
      <main>
        <h1>Remote Control Hub</h1>
        <p>正在检查服务状态…</p>
      </main>
    );
  }
  return <RouterProvider router={ROUTER} />;
}

export default App;
