import { Suspense, memo } from 'react';
import { Route, Routes } from 'react-router-dom';
import Fallback from './fallback';

const Routing = memo(({ pages }) => {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        {pages.map((page, index) => (
          <Route key={`${page.path}-${index}`} path={page.path} element={page.element} />
        ))}
      </Routes>
    </Suspense>
  );
});

Routing.displayName = 'Routing';
export default Routing;
