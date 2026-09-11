FROM alpine:3.21

RUN apk add --no-cache openssh bash coreutils \
    && adduser -D -s /bin/bash helix \
    && echo 'helix:helixpass' | chpasswd \
    && mkdir -p /run/sshd /home/helix/work /tmp/helix-e2e \
    && chown -R helix:helix /home/helix /tmp/helix-e2e \
    && ssh-keygen -A \
    && sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && grep -q '^PasswordAuthentication ' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config

RUN sed -i 's|^Subsystem[[:space:]].*sftp.*|Subsystem sftp internal-sftp|' /etc/ssh/sshd_config \
    && printf '\nPermitRootLogin no\nUsePAM no\n' >> /etc/ssh/sshd_config

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
