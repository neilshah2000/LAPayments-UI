import { useEffect, useState } from 'react';
import { CouncilList } from './CouncilList.tsx';
import { CouncilPage } from './CouncilPage.tsx';

// Hash routing: #/ -> list, #/SWK -> council page. Enough for two screens.
function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const m = /^#\/([A-Z]{3})$/.exec(hash);
  return (
    <>
      <div className="alpha" role="note">
        <span className="alpha-badge">Alpha</span> Early preview: figures may be incomplete and may change.
      </div>
      <main>{m ? <CouncilPage la={m[1]} /> : <CouncilList />}</main>
      <footer className="site">
        Contains public sector information published by UK local authorities, licensed under the{' '}
        <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/">Open Government Licence v3.0</a>.
      </footer>
    </>
  );
}
