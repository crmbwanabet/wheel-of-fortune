'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import WheelWidget from '@/components/WheelWidget';

function WheelPage() {
  const params = useSearchParams();
  const userId = params.get('userId') || null;
  const username = params.get('username') || null;

  return <WheelWidget userId={userId} username={username} />;
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <WheelPage />
    </Suspense>
  );
}
