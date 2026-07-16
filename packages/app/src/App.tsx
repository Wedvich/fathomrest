import { resetSave } from "./persistence.ts";
import { PixiReadout } from "./PixiReadout.tsx";
import { UpdatePrompt } from "./UpdatePrompt.tsx";

async function handleReset(): Promise<void> {
  await resetSave();
  location.reload();
}

export function App(): React.JSX.Element {
  return (
    <main>
      <button
        type="button"
        onClick={() => void handleReset()}
        style={{ position: "fixed", top: 12, right: 12 }}
      >
        Reset
      </button>
      <h1>Fathomrest</h1>
      <p>Live sim core — warehouse levels advancing off the render clock.</p>
      <PixiReadout />
      <UpdatePrompt />
    </main>
  );
}
