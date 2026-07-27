import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last-resort catch: a render crash shows a reload prompt, not a white page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-160 p-8 text-center">
        <h1 className="mb-2 text-2xl font-bold text-accent">fourk</h1>
        <p>Something broke on this screen.</p>
        <p className="mt-2 text-sm text-dim">{String(this.state.error)}</p>
        <button className="btn mt-4" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
