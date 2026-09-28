#include <Carbon/Carbon.h>
#include <stdio.h>
int main(void) {
  EventHotKeyRef key = NULL;
  EventHotKeyID id = {'zega', 1};
  OSStatus status = RegisterEventHotKey(49, cmdKey | optionKey, id, GetApplicationEventTarget(), kEventHotKeyExclusive, &key);
  printf("exclusive registration status=%d\n", (int) status);
  if (key) UnregisterEventHotKey(key);
  return status == noErr ? 0 : 1;
}
