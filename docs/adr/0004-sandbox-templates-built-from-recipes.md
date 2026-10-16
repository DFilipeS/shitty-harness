# Sandbox templates are E2B templates built by the harness from recipes

New sandboxes start from the provider's base image, so every new sandbox pays the whole environment bootstrap again. The harness therefore builds reusable E2B templates from small declarative recipes (`data/templates/<name>/recipe.yaml`): a recipe names a starting point — another sandbox template or a Docker image — and a list of commands, which the harness renders into E2B Template SDK calls and builds in the background.

## Considered Options

- **Snapshots of prepared sandboxes**: no recipe to write, but a snapshot bakes in a frozen project checkout and anything else that was in the sandbox, and it is a second concept to manage. Kept as a possible later source for the same concept.
- **Dockerfiles**: standard and familiar, but `FROM` only takes Docker images, so a project template cannot layer on `harness-base`.
- **Raw E2B Template SDK modules**: maximum power, but the harness cannot validate them or render them in the palette, and recipes would couple to the installed SDK.
- **Building with the E2B CLI outside the harness**: no builder, no picker, and every environment lives outside the harness.
