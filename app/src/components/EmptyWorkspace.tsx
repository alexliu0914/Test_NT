import { Center, Stack, Text } from '@mantine/core';
export default function EmptyWorkspace() {
  return <Center h="60vh"><Stack align="center" gap={4}><Text fw={600}>還沒有任何頁面</Text><Text size="sm" c="dimmed">從左側「新增頁面」開始。</Text></Stack></Center>;
}
