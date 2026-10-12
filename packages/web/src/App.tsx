import { ChatPanel } from "./components/ChatPanel.tsx";
import { ErrorToast } from "./components/ErrorToast.tsx";
import { ProviderDialog } from "./components/ProviderDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { HarnessProvider } from "./lib/store.tsx";

export function App() {
	return (
		<HarnessProvider>
			<div className="flex h-full overflow-hidden">
				<Sidebar />
				<ChatPanel />
				<ProviderDialog />
				<ErrorToast />
			</div>
		</HarnessProvider>
	);
}
