import { useEffect } from 'preact/hooks';
import { boot, useBoot } from '../boot';
import { BootScreen } from './BootScreen';
import { ChatPage } from './ChatPage';

export function App() {
  const s = useBoot();

  useEffect(() => {
    // Old bookmarks pointed at #/install, #/chat… there is one screen now.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    boot();
  }, []);

  return (
    <>
      {/* The background chosen in Settings → Appearance, behind every screen. */}
      <div class="backdrop" aria-hidden="true"><i class="blob b1" /><i class="blob b2" /><i class="blob b3" /></div>
      {s.kind === 'ready'
        ? <ChatPage key={s.modelId} modelId={s.modelId} model={s.model} contextWindow={s.contextWindow} />
        : <BootScreen s={s} />}
    </>
  );
}
