import { redirect } from 'next/navigation';

// The Phase 2 "first 50 doctors" list is replaced by search.
export default function DoctorsPage() {
  redirect('/search');
}
