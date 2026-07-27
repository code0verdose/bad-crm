import { useLogin } from '@units/auth/service/hooks/use-login.hook';

export function ForeignUnit() {
  return <div>{String(useLogin())}</div>;
}
