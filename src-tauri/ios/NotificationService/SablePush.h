#include <stddef.h>
#include <stdbool.h>

bool sable_push_sounds(const char *store_path);
bool sable_push_notify_once(const char *store_path);
bool sable_push_install_keychain(const char *group);
char *sable_push_render(const char *store_path, const char *payload_json);
void sable_push_free(char *value);
