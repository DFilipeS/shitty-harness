import { useState } from "react";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { ErrorToast } from "./components/ErrorToast.tsx";
import { ProviderDialog } from "./components/ProviderDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { HarnessProvider } from "./lib/store.tsx";

export function App() {
	const [sidebarOpen, setSidebarOpen] = useState(false);

	return (
		<HarnessProvider>
			<div className="flex h-full overflow-hidden">
				<Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
				{sidebarOpen && (
					<div
						className="fixed inset-0 z-30 bg-black/60 lg:hidden"
						onClick={() => setSidebarOpen(false)}
						aria-hidden="true"
					/>
				)}
				<ChatPanel onOpenSidebar={() => setSidebarOpen(true)} />
				<ProviderDialog />
				<ErrorToast />
			</div>
		</HarnessProvider>
	);
}
