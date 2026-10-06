import { lazy, Suspense } from 'react';
import { ErrorBoundary } from './components/error-boundary';

const WorkspaceApp = lazy(async () => {
  const { DropTheoryWorkspace } = await import('./App');
  return { default: DropTheoryWorkspace };
});

function WorkspaceLoading() {
  return (
    <main
      className="app-shell flex min-h-[100dvh] items-center justify-center bg-background text-foreground"
      role="status"
    >
      <p className="text-sm text-muted-foreground">Opening your local workspace…</p>
    </main>
  );
}

export default function RootApp() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<WorkspaceLoading />}>
        <WorkspaceApp />
      </Suspense>
    </ErrorBoundary>
  );
}