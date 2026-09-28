#include <Carbon/Carbon.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  EventHotKeyRef key = NULL;
  EventHotKeyID id = {'zega', 1};
  OSStatus status = RegisterEventHotKey(49, optionKey, id, GetApplicationEventTarget(), kEventHotKeyExclusive, &key);
  printf("exclusive registration status=%d\n", (int) status);
  if (status == noErr && argc > 1 && strcmp(argv[1], "--hold") == 0) { fflush(stdout); pause(); }
  if (key) UnregisterEventHotKey(key);
  return status == noErr ? 0 : 1;
}
