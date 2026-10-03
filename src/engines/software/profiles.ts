export const PROFILES: Record<'supervised' | 'automatic', { onApprove: 'label' | 'merge'; maxAttempts: number }> = {
  supervised: { onApprove: 'label', maxAttempts: 3 },
  automatic: { onApprove: 'merge', maxAttempts: 3 },
};
