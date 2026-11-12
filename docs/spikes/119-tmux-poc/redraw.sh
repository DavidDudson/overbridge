#!/bin/sh
while :; do printf '\033[H'; i=0; while [ $i -lt 20 ]; do printf 'line %s \033[38;2;%s;80;200m#########\033[0m\033[K\n' $i $((i*10)); i=$((i+1)); done; sleep 0.2; done
