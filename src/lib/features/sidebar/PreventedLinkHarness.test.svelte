<!-- eslint-disable svelte/no-navigation-without-resolve -- the click is cancelled, it never navigates -->
<a
  href="/rooms/!next%3Aexample.org"
  onclick={(event) => {
    event.preventDefault();
  }}>Next room</a
>
