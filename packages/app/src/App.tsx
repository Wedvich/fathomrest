import { AppShell } from "./ui/AppShell.tsx";
import { SimSessionProvider } from "./ui/SimSessionProvider.tsx";

export function App(): React.JSX.Element {
  return (
    <SimSessionProvider>
      <AppShell />
    </SimSessionProvider>
  );
}
