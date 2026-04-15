'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import WheelWidget from '@/components/WheelWidget';

function WheelPage() {
  const params = useSearchParams();
  const userId = params.get('userId') || null;

  return <WheelWidget prefillUserId={userId} />;
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <WheelPage />
    </Suspense>
  );
}
