// macOS test-only interposer. Deny and count internet sockets and DNS lookups.
// The positive-control run must report one attempt, proving the hook is loaded.
#include <sys/socket.h>
#include <netdb.h>
#include <errno.h>
#include <stdio.h>
#include <stdatomic.h>
static _Atomic unsigned attempts;
static int audit_socket(int domain, int type, int protocol) {
    if (domain == AF_INET || domain == AF_INET6) {
        atomic_fetch_add(&attempts, 1); errno = EPERM; return -1;
    }
    return socket(domain, type, protocol);
}
static int audit_getaddrinfo(const char *node, const char *service,
                            const struct addrinfo *hints, struct addrinfo **result) {
    (void)node; (void)service; (void)hints; (void)result;
    atomic_fetch_add(&attempts, 1); return EAI_FAIL;
}
__attribute__((used)) static struct { const void *replacement; const void *original; }
interposers[] __attribute__((section("__DATA,__interpose"))) = {
    { (const void *)audit_socket, (const void *)socket },
    { (const void *)audit_getaddrinfo, (const void *)getaddrinfo },
};
__attribute__((destructor)) static void report(void) {
    fprintf(stderr, "NETWORK_AUDIT attempts=%u\n", atomic_load(&attempts));
}
