import { Outlet } from 'react-router';
import { AppSidebar } from '@/renderer/src/components/SideBar/app-sidebar';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@renderer/components/ui/sidebar';
import { VoiceRuntime } from '@renderer/components/CyrvisVoice/VoiceRuntime';
import CyrvisGaze from '@renderer/components/CyrvisGaze';
import CyrvisRuntimePanel from '@renderer/components/CyrvisRuntime';
import { FollowUpDialog } from '@renderer/components/Proactivity/FollowUpDialog';

export function MainLayout() {
  return (
    <SidebarProvider
      style={{ '--sidebar-width-icon': '72px' }}
      className="flex h-screen w-full bg-white"
    >
      <AppSidebar />
      <SidebarInset className="flex-1">
        <div className="cyrvis-window-bar draggable-area">
          <SidebarTrigger className="non-draggable-area" />
        </div>
        <div className="cyrvis-content">
          <Outlet />
        </div>
      </SidebarInset>
      <VoiceRuntime />
      {/* Only the main workbench owns gaze; task widgets must not stop it. */}
      <CyrvisGaze />
      <CyrvisRuntimePanel />
      <FollowUpDialog />
    </SidebarProvider>
  );
}
