import { useQuery } from '@tanstack/react-query';

export function BoardPage() {
  const board = useQuery({ queryKey: ['board'], queryFn: async () => [] });

  return <div>{String(board.status)}</div>;
}
