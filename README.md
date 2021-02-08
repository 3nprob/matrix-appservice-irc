Matrix IRC Bridge
----------------------

[![Docker Automated build](https://img.shields.io/docker/cloud/build/matrixdotorg/matrix-appservice-irc.svg)](https://hub.docker.com/r/matrixdotorg/matrix-appservice-irc)
[![Build Status](https://badge.buildkite.com/f33ff3f5e59aed3057cec0215a84e26747581e0fcb09b4b699.svg?branch=master)](https://buildkite.com/matrix-dot-org/matrix-appservice-irc)
[![#irc:matrix.org](https://img.shields.io/matrix/irc:matrix.org.svg?server_fqdn=matrix.org&label=%23irc:matrix.org&logo=matrix)](https://matrix.to/#/#irc:matrix.org)
[![Documentation Status](https://readthedocs.org/projects/matrix-appservice-irc/badge/?version=latest)](https://matrix-appservice-irc.readthedocs.io/en/latest/?badge=latest)

This is an IRC bridge for [Matrix](https://matrix.org). If you're upgrading from an
old release, be sure to read the [CHANGELOG](./CHANGELOG.md) as there may be breaking changes between releases.

This bridge will pass all IRC messages through to Matrix, and all Matrix messages through to IRC. It is highly
configurable and is currently used on the matrix.org homeserver to bridge a number of popular IRC networks
including Freenode and OFTC.


## What does it do?

On startup, the bridge will join Matrix clients to the IRC channels specified in the configuration file. It
will then listen for incoming IRC messages and forward them through to Matrix rooms
Each real Matrix user is represented by an IRC client, and each real IRC client is represented by a Matrix user. Full
two-way communication in channels and PMs are supported, along with a huge array of customisation options.


## Usage

### Joining a channel

Joining a public channel over the bridge is as easy as joining an alias, for instance:

`#freenode_#python:matrix.org` maps to the `#python` channel on Freenode.

### PMing a user

Sending a PM to an IRC user means starting a conversation with:

`@freenode_Alice:matrix.org` maps to the nickname `Alice` on Freenode.

If a PM is sent from the IRC side, it will either appear in your existing room or you will be invited
to a new room.

### Customising your experience

You may also want to customise your nickname or set a password to authenticate with services, you
can do this by PMing the bridge bot user. E.g. the matrix.org freenode bridge user is `@appservice-irc:matrix.org`.

```
!nick Alice
!storepass MySecretPassword
```

More commands can be found [here](https://matrix-org.github.io/matrix-appservice-irc/usage#BotCommands)

The alias and user formats may differer depending on the bridge you are using, so be sure to check with the
server administrator if the above defaults are not working for you. Server administrators can
check [the sample config file](./config.sample.yaml) for instructions on how to change the templates
for users and channels.

The wiki [contains a list of public IRC networks](https://github.com/matrix-org/matrix-appservice-irc/wiki/Bridged-IRC-networks)
including alias and user_id formats.


## Setting up your own bridge

You will need a Matrix homeserver to run this bridge. Any homeserver that supports the AS API
should work.

See [the getting started docs](https://matrix-org.github.io/matrix-appservice-irc/bridge_setup)
for instructions on how to set up the bridge.

### Configuration

See [the sample config file](./config.sample.yaml) for an explanation of the
configuration options available.


### Documentation

Documentation can be found on [GitHub Pages](https://matrix-org.github.io/matrix-appservice-irc).

You can build the documentaion yourself by:
```
# Ensure that Rust is installed on your system.
# cargo install mdbook
mdbook build
sensible-browser book/index.html
```

## Contributing
Please see the [CONTRIBUTING](./CONTRIBUTING.md) file for information on contributing.